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
 *  4. Memory derivation with source-visibility preservation
 *  5. Memory promotion emitting `memory.promoted`
 *  6. Cross-entity search (actors, channels, threads, messages, memory)
 *  7. Full audit trail verification
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
      plugins: ["memory", "search"],
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
      "memory:promote",
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
  test("permission → artifact → memory → search → audit all work end-to-end", async () => {
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

    // ── 4. Memory plugin has derived units ──
    type MemoryUnitDto = {
      id: string;
      canonicalText: string;
      summary: string;
      keywords: string[];
      sourceVisibility: string;
      sourceMessageIds: string[];
      promoted: boolean;
    };
    const memory = await http<{ units: MemoryUnitDto[] }>(
      "GET",
      `/v1/memory?streamId=${ctx.channelId}`,
      ctx.admin,
    );
    expect(memory.status).toBe(200);
    const unitTexts = memory.body.units.map((u) => u.canonicalText);
    expect(unitTexts).toContain("kickoff: cutting v1.0 today");
    expect(unitTexts).toContain("plan: run tests, ship binary, announce in #launch");
    expect(unitTexts).toContain("build complete, hash=deadbeef");
    for (const u of memory.body.units) {
      expect(u.sourceVisibility).toBe("private");
      expect(u.promoted).toBe(false);
      expect(u.sourceMessageIds.length).toBeGreaterThanOrEqual(1);
    }

    // Outsider can't peek into the private channel's memory.
    const outsiderMemory = await http<{ error: string; code: string }>(
      "GET",
      `/v1/memory?streamId=${ctx.channelId}`,
      ctx.outsider,
    );
    expect(outsiderMemory.status).toBe(403);
    expect(outsiderMemory.body.code).toBe("PERMISSION_DENIED");

    // Memory from a completely unrelated private channel does not leak.
    const otherChannelUnits = await http<{ units: unknown[] }>(
      "GET",
      `/v1/memory?streamId=${ctx.privateChannelId}`,
      ctx.admin,
    );
    expect(otherChannelUnits.body.units).toHaveLength(0);

    // ── 5. Promote one unit; outsider can now see exactly that one ──
    const toPromote = memory.body.units.find((u) => u.canonicalText.startsWith("plan:"));
    expect(toPromote).toBeDefined();
    const promote = await http<{ unit: { promoted: boolean; promotionSummary: string | null } }>(
      "POST",
      `/v1/memory/${toPromote!.id}/promote`,
      ctx.admin,
      { summary: "shareable release plan" },
    );
    expect(promote.status).toBe(200);
    expect(promote.body.unit.promoted).toBe(true);
    expect(promote.body.unit.promotionSummary).toBe("shareable release plan");

    // Double-promote is idempotent in the UX sense (returns current state).
    const repromote = await http<{ unit: { promoted: boolean } }>(
      "POST",
      `/v1/memory/${toPromote!.id}/promote`,
      ctx.admin,
      {},
    );
    expect(repromote.body.unit.promoted).toBe(true);

    // Outsider can fetch the promoted unit directly,
    const outsiderUnit = await http<{ unit: { promoted: boolean; id: string } }>(
      "GET",
      `/v1/memory/${toPromote!.id}`,
      ctx.outsider,
    );
    expect(outsiderUnit.status).toBe(200);
    expect(outsiderUnit.body.unit.promoted).toBe(true);
    expect(outsiderUnit.body.unit.id).toBe(toPromote!.id);

    // …but not other, still-scoped units.
    const stillPrivate = memory.body.units.find((u) => u.canonicalText.startsWith("kickoff:"));
    const privateUnitAsOutsider = await http<{ error: string }>(
      "GET",
      `/v1/memory/${stillPrivate!.id}`,
      ctx.outsider,
    );
    expect(privateUnitAsOutsider.status).toBe(403);

    // Org-wide promoted listing shows exactly one unit to the outsider.
    const orgPromoted = await http<{ units: Array<{ id: string; canonicalText: string; promoted: boolean }> }>(
      "GET",
      "/v1/memory?promoted=true",
      ctx.outsider,
    );
    expect(orgPromoted.status).toBe(200);
    expect(orgPromoted.body.units.map((u) => u.id)).toEqual([toPromote!.id]);
    for (const u of orgPromoted.body.units) expect(u.promoted).toBe(true);

    // ── 6. memory:promote gate for non-admins ──
    const uninvited = await http<{ code: string }>("POST", `/v1/memory/${stillPrivate!.id}/promote`, ctx.agent, {});
    expect(uninvited.status).toBe(403);

    // ── 6b. Cross-entity search (search plugin) ──
    // Admin can find their own message about "kickoff", the channel, and
    // the actor "coder-bot" in a single mixed-entity result set.
    const heroSearch = await http<{
      hits: Array<{ entityType: string; entityId: string; title: string }>;
    }>(
      "GET",
      `/v1/search?q=${encodeURIComponent("kickoff")}`,
      ctx.admin,
    );
    expect(heroSearch.status).toBe(200);
    expect(heroSearch.body.hits.some((h) => h.entityType === "message")).toBe(true);
    expect(heroSearch.body.hits.some((h) => h.entityType === "memory")).toBe(true);

    const actorSearch = await http<{
      hits: Array<{ entityType: string; title: string }>;
    }>(
      "GET",
      `/v1/search?q=${encodeURIComponent("coder")}&entityTypes=actor`,
      ctx.admin,
    );
    expect(actorSearch.status).toBe(200);
    expect(actorSearch.body.hits[0]?.entityType).toBe("actor");
    expect(actorSearch.body.hits[0]?.title).toContain("coder");

    // Outsider only sees the org-promoted memory hit when searching for
    // "plan" — no private message/memory hits leak.
    const outsiderSearch = await http<{
      hits: Array<{ entityType: string; promoted: boolean; entityId: string }>;
    }>(
      "GET",
      `/v1/search?q=${encodeURIComponent("plan")}`,
      ctx.outsider,
    );
    expect(outsiderSearch.status).toBe(200);
    for (const h of outsiderSearch.body.hits) {
      if (h.entityType === "memory") expect(h.promoted).toBe(true);
      // No private message hits should leak.
      expect(h.entityType).not.toBe("message");
    }

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
      "memory.promoted",
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
