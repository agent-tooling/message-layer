import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { connect, type SqlDatabase } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { createApp } from "../../src/http.js";
import { MessageLayer } from "../../src/service.js";
import { HttpClient, appFetcher } from "../helpers/http-client.js";
import type { Principal } from "../../src/types.js";

type Harness = {
  db: SqlDatabase;
  service: MessageLayer;
  http: HttpClient;
  close: () => Promise<void>;
};

let harness: Harness;

async function makeHarness(): Promise<Harness> {
  const db = await connect(`memory://http-${Math.random().toString(16).slice(2)}`);
  const bus = new InProcessEventBus();
  const service = new MessageLayer(db, { bus });
  const app = createApp(service);
  const http = new HttpClient("http://localhost", appFetcher(app));
  return {
    db,
    service,
    http,
    close: async () => {
      await db.close?.();
    },
  };
}

beforeEach(async () => {
  harness = await makeHarness();
});
afterEach(async () => {
  await harness.close();
});

async function createOrgAndAdmin(): Promise<{ orgId: string; admin: Principal }> {
  const org = await harness.http.post<{ orgId: string }>("/v1/orgs", { name: "Acme" }, null);
  const actor = await harness.http.post<{ actorId: string }>(
    "/v1/actors",
    { orgId: org.body.orgId, actorType: "human", displayName: "admin" },
    null,
  );
  return {
    orgId: org.body.orgId,
    admin: {
      actorId: actor.body.actorId,
      orgId: org.body.orgId,
      scopes: ["grant:create", "channel:create", "thread:create", "message:append", "audit:read", "channel:admin"],
      provider: "test",
    },
  };
}

describe("HTTP / health", () => {
  test("GET /health returns ok", async () => {
    const res = await harness.http.get<{ ok: boolean }>("/health", null);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("HTTP / principal handling", () => {
  test("missing principal rejected with 401 on authenticated routes", async () => {
    const res = await harness.http.get("/v1/channels", null);
    expect(res.status).toBe(401);
  });

  test("malformed principal header rejected with 401", async () => {
    const res = await harness.http.get("/v1/channels", null, { "x-principal": "not-json" });
    expect(res.status).toBe(401);
  });
});

describe("HTTP / end-to-end workflow", () => {
  test("full orchestration: org → actors → channel → messages → threads → cursors → grants → permission request", async () => {
    const { orgId, admin } = await createOrgAndAdmin();

    const bot = await harness.http.post<{ actorId: string }>(
      "/v1/actors",
      { orgId, actorType: "agent", displayName: "bot" },
      null,
    );
    const user = await harness.http.post<{ actorId: string }>(
      "/v1/actors",
      { orgId, actorType: "human", displayName: "user" },
      null,
    );

    const botPrincipal: Principal = {
      actorId: bot.body.actorId,
      orgId,
      scopes: [],
      provider: "test",
    };
    const userPrincipal: Principal = {
      actorId: user.body.actorId,
      orgId,
      scopes: [],
      provider: "test",
    };

    const channel = await harness.http.post<{ channelId: string }>(
      "/v1/channels",
      { name: "general", visibility: "public" },
      admin,
    );
    expect(channel.status).toBe(200);
    const channelId = channel.body.channelId;

    // bot: add membership (public channel already gives read; grant lets append)
    await harness.http.post(
      "/v1/grants",
      { actorId: bot.body.actorId, resourceType: "channel", resourceId: channelId, capability: "message:append" },
      admin,
    );

    const firstMsg = await harness.http.post<{ messageId: string; streamSeq: number; idempotent: boolean }>(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "hello" } }],
        idempotencyKey: "bot-1",
      },
      botPrincipal,
    );
    expect(firstMsg.status).toBe(200);
    expect(firstMsg.body.streamSeq).toBe(1);

    // Replay same idempotency key: idempotent=true
    const replayMsg = await harness.http.post<{ messageId: string; streamSeq: number; idempotent: boolean }>(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "hello-dup" } }],
        idempotencyKey: "bot-1",
      },
      botPrincipal,
    );
    expect(replayMsg.body.idempotent).toBe(true);
    expect(replayMsg.body.messageId).toBe(firstMsg.body.messageId);

    // User without grant is denied
    const deny = await harness.http.post<{ error: string; code: string }>(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "no" } }],
        idempotencyKey: "u-1",
      },
      userPrincipal,
    );
    expect(deny.status).toBe(403);
    expect(deny.body.code).toBe("PERMISSION_DENIED");

    // autoRequestOnDeny: instead of 403, returns { denied: true, requestId }
    const autoReq = await harness.http.post<{ denied: boolean; requestId: string }>(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "please" } }],
        idempotencyKey: "u-2",
        autoRequestOnDeny: true,
      },
      userPrincipal,
    );
    expect(autoReq.status).toBe(200);
    expect(autoReq.body.denied).toBe(true);
    expect(autoReq.body.requestId).toMatch(/^[0-9a-f]{32}$/);

    const pendingRequest = await harness.http.get<{ request: { status: string; action: string } }>(
      `/v1/permission-requests/${autoReq.body.requestId}`,
      admin,
    );
    expect(pendingRequest.status).toBe(200);
    expect(pendingRequest.body.request.status).toBe("open");
    expect(pendingRequest.body.request.action).toBe("message:append");

    // Admin approves -> user can append
    const resolved = await harness.http.post<{ status: string; grantId: string }>(
      `/v1/permission-requests/${autoReq.body.requestId}/resolve`,
      { approve: true },
      admin,
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("approved");

    const resolvedRequest = await harness.http.get<{ request: { status: string; grantId: string | null } }>(
      `/v1/permission-requests/${autoReq.body.requestId}`,
      admin,
    );
    expect(resolvedRequest.status).toBe(200);
    expect(resolvedRequest.body.request.status).toBe("approved");
    expect(resolvedRequest.body.request.grantId).toBeTruthy();

    const approved = await harness.http.post<{ messageId: string }>(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "approval_response", payload: { approved: true } }],
        idempotencyKey: "u-3",
      },
      userPrincipal,
    );
    expect(approved.status).toBe(200);

    // thread
    const threadRes = await harness.http.post<{ threadId: string }>(
      "/v1/threads",
      { channelId, parentMessageId: firstMsg.body.messageId },
      admin,
    );
    expect(threadRes.status).toBe(200);
    const threadList = await harness.http.get<{ threads: Array<{ id: string }> }>(`/v1/channels/${channelId}/threads`, admin);
    expect(threadList.body.threads.map((t) => t.id)).toContain(threadRes.body.threadId);

    // message listing + subscribe
    const messages = await harness.http.get<{ messages: Array<{ streamSeq: number }> }>(
      `/v1/streams/${channelId}/messages`,
      admin,
    );
    expect(messages.body.messages.map((m) => m.streamSeq)).toEqual([1, 2]);

    const subscribe = await harness.http.get<{ events: Array<{ type: string; streamSeq: number | null }> }>(
      `/v1/streams/${channelId}/subscribe`,
      admin,
    );
    expect(subscribe.body.events.filter((e) => e.type === "message.appended").length).toBe(2);

    // cursor roundtrip
    await harness.http.post("/v1/cursors", { streamId: channelId, lastSeenSeq: 2, lastAckSeq: 2 }, admin);
    const cursor = await harness.http.get<{ cursor: { lastSeenSeq: number } }>(
      `/v1/streams/${channelId}/cursor`,
      admin,
    );
    expect(cursor.body.cursor.lastSeenSeq).toBe(2);

    // redaction
    const redact = await harness.http.post(
      `/v1/messages/${firstMsg.body.messageId}/redact`,
      { reason: "test" },
      botPrincipal,
    );
    expect(redact.status).toBe(200);
    const afterRedact = await harness.http.get<{ messages: Array<{ id: string; redacted: boolean; parts: unknown[] }> }>(
      `/v1/streams/${channelId}/messages`,
      admin,
    );
    const redacted = afterRedact.body.messages.find((m) => m.id === firstMsg.body.messageId);
    expect(redacted?.redacted).toBe(true);
    expect(redacted?.parts).toEqual([]);

    // audit
    const audit = await harness.http.get<{ rows: Array<{ eventType: string }> }>("/v1/audit/rows", admin);
    expect(audit.body.rows.length).toBeGreaterThan(5);
    const verify = await harness.http.get<{ valid: boolean }>("/v1/audit/verify", admin);
    expect(verify.body.valid).toBe(true);

    // audit without scope is 403
    const noScope = { ...admin, scopes: [] };
    const noAudit = await harness.http.get("/v1/audit/rows", noScope);
    expect(noAudit.status).toBe(403);
  });
});

describe("HTTP / privacy", () => {
  test("private channels are not enumerable to non-members", async () => {
    const { orgId, admin } = await createOrgAndAdmin();
    const alice = await harness.http.post<{ actorId: string }>(
      "/v1/actors",
      { orgId, actorType: "human", displayName: "alice" },
      null,
    );
    const alicePrincipal: Principal = { actorId: alice.body.actorId, orgId, scopes: [], provider: "test" };

    const priv = await harness.http.post<{ channelId: string }>(
      "/v1/channels",
      { name: "private" },
      admin,
    );
    const pub = await harness.http.post<{ channelId: string }>(
      "/v1/channels",
      { name: "public", visibility: "public" },
      admin,
    );

    const aliceList = await harness.http.get<{ channels: Array<{ id: string }> }>("/v1/channels", alicePrincipal);
    const ids = aliceList.body.channels.map((c) => c.id);
    expect(ids).toContain(pub.body.channelId);
    expect(ids).not.toContain(priv.body.channelId);

    const aliceSub = await harness.http.get<{ error: string }>(
      `/v1/streams/${priv.body.channelId}/subscribe`,
      alicePrincipal,
    );
    expect(aliceSub.status).toBe(403);
  });
});
