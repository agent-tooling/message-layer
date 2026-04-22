import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defaultServerConfig } from "../../src/config.js";
import { startServer, type RunningServer } from "../../src/server-runtime.js";
import type { Principal } from "../../src/types.js";

/**
 * The AGENTS.md "hero flow" exercised end-to-end against a real running
 * server (HTTP + WS + plugins) backed by real PGlite. Covers:
 *
 *  1. Bootstrap: org, human admin, agent, app attached to one channel
 *  2. Permission request lifecycle (agent → human approval loop)
 *  3. Artifact upload + download (stream-scoped, sha256-verified)
 *  4. Scoped knowledge derivation with source-visibility preservation
 *  5. Knowledge promotion emitting `knowledge.promoted`
 *  6. Full audit trail verification
 *
 * No mocks, no stubs — everything runs through the same code paths a real
 * developer would hit after `pnpm run dev`.
 */

type ActorBundle = {
  orgId: string;
  admin: Principal;
  agent: Principal;
  app: Principal;
  outsider: Principal;
  channelId: string;
  privateChannelId: string;
};

let server: RunningServer;

beforeEach(async () => {
  server = await startServer({
    port: 0,
    logger: () => {},
    config: {
      ...defaultServerConfig({}),
      port: 0,
      storage: { adapter: "pglite", path: `memory://hero-${Math.random().toString(16).slice(2)}` },
      artifacts: { kind: "memory", maxBytes: 5 * 1024 * 1024 },
      plugins: ["scoped-knowledge"],
    },
  });
});

afterEach(async () => {
  await server?.close();
});

async function http<T = unknown>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  principal: Principal | null,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (principal) headers["x-principal"] = JSON.stringify(principal);
  const res = await fetch(`${server.address}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as T) : ({} as T);
  return { status: res.status, body: parsed };
}

async function httpRaw(
  method: "GET",
  path: string,
  principal: Principal | null,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (principal) headers["x-principal"] = JSON.stringify(principal);
  return fetch(`${server.address}${path}`, { method, headers });
}

async function bootstrap(): Promise<ActorBundle> {
  const org = await http<{ orgId: string }>("POST", "/v1/orgs", null, { name: "launch-prep" });
  const orgId = org.body.orgId;

  const adminActor = await http<{ actorId: string }>("POST", "/v1/actors", null, {
    orgId,
    actorType: "human",
    displayName: "Alice (admin)",
  });
  const agentActor = await http<{ actorId: string }>("POST", "/v1/actors", null, {
    orgId,
    actorType: "agent",
    displayName: "coder-bot",
  });
  const appActor = await http<{ actorId: string }>("POST", "/v1/actors", null, {
    orgId,
    actorType: "app",
    displayName: "release-app",
  });
  const outsiderActor = await http<{ actorId: string }>("POST", "/v1/actors", null, {
    orgId,
    actorType: "human",
    displayName: "not-invited",
  });

  const admin: Principal = {
    actorId: adminActor.body.actorId,
    orgId,
    scopes: [
      "channel:create",
      "channel:admin",
      "thread:create",
      "grant:create",
      "message:append",
      "knowledge:promote",
      "audit:read",
    ],
    provider: "test",
  };
  const agent: Principal = {
    actorId: agentActor.body.actorId,
    orgId,
    scopes: [],
    provider: "test",
  };
  const app: Principal = {
    actorId: appActor.body.actorId,
    orgId,
    scopes: [],
    provider: "test",
  };
  const outsider: Principal = {
    actorId: outsiderActor.body.actorId,
    orgId,
    scopes: [],
    provider: "test",
  };

  const channel = await http<{ channelId: string }>("POST", "/v1/channels", admin, {
    name: "launch",
    visibility: "private",
  });
  const channelId = channel.body.channelId;
  const priv = await http<{ channelId: string }>("POST", "/v1/channels", admin, {
    name: "finance",
    visibility: "private",
  });
  const privateChannelId = priv.body.channelId;

  for (const actorId of [agent.actorId, app.actorId]) {
    const add = await http("POST", `/v1/channels/${channelId}/members`, admin, { actorId });
    expect(add.status).toBe(200);
  }

  return { orgId, admin, agent, app, outsider, channelId, privateChannelId };
}

describe("hero flow — human + agent + app in one channel", () => {
  test("permission → artifact → knowledge → audit all work end-to-end", async () => {
    const ctx = await bootstrap();

    // ── 1. Admin posts the first message; agent gets append grant and posts a plan. ──
    await http("POST", "/v1/messages", ctx.admin, {
      streamId: ctx.channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "kickoff: cutting v1.0 today" } }],
      idempotencyKey: "kickoff-1",
    });

    await http("POST", "/v1/grants", ctx.admin, {
      actorId: ctx.agent.actorId,
      resourceType: "channel",
      resourceId: ctx.channelId,
      capability: "message:append",
    });
    await http("POST", "/v1/grants", ctx.admin, {
      actorId: ctx.agent.actorId,
      resourceType: "channel",
      resourceId: ctx.channelId,
      capability: "artifact:register",
    });

    const plan = await http<{ messageId: string; streamSeq: number }>("POST", "/v1/messages", ctx.agent, {
      streamId: ctx.channelId,
      streamType: "channel",
      parts: [
        { type: "text", payload: { text: "plan: run tests, ship binary, announce in #launch" } },
      ],
      idempotencyKey: "agent-plan-1",
    });
    expect(plan.status).toBe(200);

    // ── 2. App lacks message:append → permission request flow ──
    // Raw 403 first.
    const raw403 = await http<{ code: string }>("POST", "/v1/messages", ctx.app, {
      streamId: ctx.channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "build complete" } }],
      idempotencyKey: "app-try-1",
    });
    expect(raw403.status).toBe(403);
    expect(raw403.body.code).toBe("PERMISSION_DENIED");

    // Then autoRequestOnDeny opens a permission request.
    const autoReq = await http<{ denied: boolean; requestId: string; capability: string }>(
      "POST",
      "/v1/messages",
      ctx.app,
      {
        streamId: ctx.channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "build complete" } }],
        idempotencyKey: "app-try-2",
        autoRequestOnDeny: true,
      },
    );
    expect(autoReq.status).toBe(200);
    expect(autoReq.body.denied).toBe(true);
    expect(autoReq.body.capability).toBe("message:append");
    const requestId = autoReq.body.requestId;

    // Admin inspects the queue and resolves.
    const queue = await http<{ requests: Array<{ requestId: string }> }>(
      "GET",
      `/v1/permission-requests?actorId=${ctx.app.actorId}`,
      ctx.admin,
    );
    expect(queue.body.requests.map((r) => r.requestId)).toContain(requestId);

    const resolved = await http<{ status: string; grantId: string }>(
      "POST",
      `/v1/permission-requests/${requestId}/resolve`,
      ctx.admin,
      { approve: true, notes: "ship it" },
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("approved");

    // App now succeeds on the same idempotencyKey path.
    const appMsg = await http<{ messageId: string; streamSeq: number }>("POST", "/v1/messages", ctx.app, {
      streamId: ctx.channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "build complete, hash=deadbeef" } }],
      idempotencyKey: "app-try-3",
    });
    expect(appMsg.status).toBe(200);

    // ── 3. Agent uploads an artifact, app downloads + verifies sha256 ──
    const bytes = Buffer.from("fake tarball contents :: v1.0.0", "utf8");
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    const upload = await http<{ artifact: { id: string; sha256: string; size: number } }>(
      "POST",
      "/v1/artifacts",
      ctx.agent,
      {
        streamId: ctx.channelId,
        streamType: "channel",
        filename: "release-v1.0.0.tar",
        contentType: "application/x-tar",
        contentBase64: bytes.toString("base64"),
      },
    );
    expect(upload.status).toBe(200);
    expect(upload.body.artifact.sha256).toBe(expectedSha);
    const artifactId = upload.body.artifact.id;

    const download = await httpRaw("GET", `/v1/artifacts/${artifactId}/content`, ctx.app);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/x-tar");
    expect(download.headers.get("x-artifact-sha256")).toBe(expectedSha);
    const downloaded = Buffer.from(await download.arrayBuffer());
    expect(downloaded.equals(bytes)).toBe(true);

    // Outsider cannot download, even with the id.
    const outsiderDl = await httpRaw("GET", `/v1/artifacts/${artifactId}/content`, ctx.outsider);
    expect(outsiderDl.status).toBe(403);

    // ── 4. Scoped-knowledge plugin has derived entries ──
    const knowledge = await http<{ entries: Array<{ id: string; text: string; sourceVisibility: string; promoted: boolean }> }>(
      "GET",
      `/v1/knowledge?streamId=${ctx.channelId}`,
      ctx.admin,
    );
    expect(knowledge.status).toBe(200);
    const entryTexts = knowledge.body.entries.map((e) => e.text);
    expect(entryTexts).toContain("kickoff: cutting v1.0 today");
    expect(entryTexts).toContain("plan: run tests, ship binary, announce in #launch");
    expect(entryTexts).toContain("build complete, hash=deadbeef");
    for (const e of knowledge.body.entries) {
      expect(e.sourceVisibility).toBe("private");
      expect(e.promoted).toBe(false);
    }

    // Outsider can't peek into the private channel's knowledge.
    const outsiderKnowledge = await http<{ error: string; code: string }>(
      "GET",
      `/v1/knowledge?streamId=${ctx.channelId}`,
      ctx.outsider,
    );
    expect(outsiderKnowledge.status).toBe(403);
    expect(outsiderKnowledge.body.code).toBe("PERMISSION_DENIED");

    // Knowledge from a completely unrelated private channel does not leak.
    const otherChannelEntries = await http<{ entries: unknown[] }>(
      "GET",
      `/v1/knowledge?streamId=${ctx.privateChannelId}`,
      ctx.admin,
    );
    expect(otherChannelEntries.body.entries).toHaveLength(0);

    // ── 5. Promote one entry; outsider can now see exactly that entry ──
    const toPromote = knowledge.body.entries.find((e) => e.text.startsWith("plan:"));
    expect(toPromote).toBeDefined();
    const promote = await http<{ entry: { promoted: boolean; promotionSummary: string | null } }>(
      "POST",
      `/v1/knowledge/${toPromote!.id}/promote`,
      ctx.admin,
      { summary: "shareable release plan" },
    );
    expect(promote.status).toBe(200);
    expect(promote.body.entry.promoted).toBe(true);
    expect(promote.body.entry.promotionSummary).toBe("shareable release plan");

    // Double-promote is idempotent in the UX sense (returns current state).
    const repromote = await http<{ entry: { promoted: boolean } }>(
      "POST",
      `/v1/knowledge/${toPromote!.id}/promote`,
      ctx.admin,
      {},
    );
    expect(repromote.body.entry.promoted).toBe(true);

    // Outsider can fetch the promoted entry directly,
    const outsiderEntry = await http<{ entry: { promoted: boolean; id: string } }>(
      "GET",
      `/v1/knowledge/${toPromote!.id}`,
      ctx.outsider,
    );
    expect(outsiderEntry.status).toBe(200);
    expect(outsiderEntry.body.entry.promoted).toBe(true);
    expect(outsiderEntry.body.entry.id).toBe(toPromote!.id);

    // …but not other, still-scoped entries.
    const stillPrivate = knowledge.body.entries.find((e) => e.text.startsWith("kickoff:"));
    const privateEntryAsOutsider = await http<{ error: string }>(
      "GET",
      `/v1/knowledge/${stillPrivate!.id}`,
      ctx.outsider,
    );
    expect(privateEntryAsOutsider.status).toBe(403);

    // Org-wide promoted listing shows exactly one entry to the outsider.
    const orgPromoted = await http<{ entries: Array<{ id: string; text: string; promoted: boolean }> }>(
      "GET",
      "/v1/knowledge?includePromotedElsewhere=true",
      ctx.outsider,
    );
    expect(orgPromoted.status).toBe(200);
    expect(orgPromoted.body.entries.map((e) => e.id)).toEqual([toPromote!.id]);
    for (const e of orgPromoted.body.entries) expect(e.promoted).toBe(true);

    // ── 6. Knowledge:promote gate for non-admins ──
    const uninvited = await http<{ code: string }>("POST", `/v1/knowledge/${stillPrivate!.id}/promote`, ctx.agent, {});
    expect(uninvited.status).toBe(403);

    // ── 7. Full audit trail captures every expected event and verifies ──
    const rows = await http<{ rows: Array<{ eventType: string }> }>("GET", "/v1/audit/rows", ctx.admin);
    expect(rows.status).toBe(200);
    const types = rows.body.rows.map((r) => r.eventType);
    const required = [
      "org.created",
      "membership.updated",
      "channel.created",
      "message.appended",
      "grant.created",
      "permission_request.created",
      "permission_request.resolved",
      "artifact.registered",
      "knowledge.promoted",
    ] as const;
    for (const t of required) {
      expect(types).toContain(t);
    }

    const verify = await http<{ valid: boolean; firstBadIndex: number | null; total: number }>(
      "GET",
      "/v1/audit/verify",
      ctx.admin,
    );
    expect(verify.body.valid).toBe(true);
    expect(verify.body.total).toBe(rows.body.rows.length);
  });
});
