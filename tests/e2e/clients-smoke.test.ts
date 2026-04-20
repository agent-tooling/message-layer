import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { startServer, type RunningServer } from "../../src/server-runtime.js";
import { defaultServerConfig } from "../../src/config.js";

// End-to-end smoke tests that exercise every client-facing surface the
// terminal and Next.js clients rely on, against a real HTTP + WS server
// bound to a random port. No mocks, no internal imports of the service
// after server boot — everything goes through the wire.

let server: RunningServer;
let baseUrl: string;

beforeAll(async () => {
  server = await startServer({
    port: 0,
    logger: () => {},
    config: { ...defaultServerConfig({}), plugins: [], port: 0, websocket: true },
  });
  baseUrl = server.address;
});

afterAll(async () => {
  await server?.close();
});

type Principal = { actorId: string; orgId: string; scopes: string[]; provider: string };

async function api<T>(path: string, options: { method?: string; body?: unknown; principal?: Principal } = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.principal) headers["x-principal"] = JSON.stringify(options.principal);
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  const body = text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
  return { status: res.status, body };
}

async function waitForWsMessage(
  ws: NodeWebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws timeout")), timeoutMs);
    const handler = (raw: NodeWebSocket.RawData) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

describe("clients smoke / terminal-shaped HTTP workflow", () => {
  test("exercises every endpoint a terminal or next.js client depends on", async () => {
    // 1. bootstrap: org + two actors (admin human, bot agent)
    const orgRes = await api<{ orgId: string }>("/v1/orgs", { method: "POST", body: { name: "SmokeOrg" } });
    expect(orgRes.status).toBe(200);
    const { orgId } = orgRes.body;

    const adminRes = await api<{ actorId: string }>("/v1/actors", {
      method: "POST",
      body: { orgId, actorType: "human", displayName: "admin" },
    });
    const botRes = await api<{ actorId: string }>("/v1/actors", {
      method: "POST",
      body: { orgId, actorType: "agent", displayName: "bot" },
    });
    const userRes = await api<{ actorId: string }>("/v1/actors", {
      method: "POST",
      body: { orgId, actorType: "human", displayName: "user" },
    });
    const admin: Principal = {
      actorId: adminRes.body.actorId,
      orgId,
      scopes: ["grant:create", "channel:create", "thread:create", "message:append", "audit:read", "channel:admin"],
      provider: "smoke",
    };
    const bot: Principal = { actorId: botRes.body.actorId, orgId, scopes: [], provider: "smoke" };
    const user: Principal = { actorId: userRes.body.actorId, orgId, scopes: [], provider: "smoke" };

    // 2. create a private channel; non-member must NOT see it
    const chanRes = await api<{ channelId: string }>("/v1/channels", {
      method: "POST",
      body: { name: "general", visibility: "private" },
      principal: admin,
    });
    expect(chanRes.status).toBe(200);
    const channelId = chanRes.body.channelId;

    const userList = await api<{ channels: Array<{ id: string }> }>("/v1/channels", { principal: user });
    expect(userList.body.channels.map((c) => c.id)).not.toContain(channelId);

    // 3. add bot as member + grant append; list channel members
    await api("/v1/channels/" + channelId + "/members", {
      method: "POST",
      body: { actorId: bot.actorId, role: "member" },
      principal: admin,
    });
    await api("/v1/grants", {
      method: "POST",
      body: { actorId: bot.actorId, resourceType: "channel", resourceId: channelId, capability: "message:append" },
      principal: admin,
    });
    const members = await api<{ members: Array<{ actorId: string }> }>(
      `/v1/channels/${channelId}/members`,
      { principal: admin },
    );
    expect(members.body.members.map((m) => m.actorId)).toEqual(
      expect.arrayContaining([admin.actorId, bot.actorId]),
    );

    // 4. bot posts a message; idempotency replays return the same record
    const first = await api<{ messageId: string; streamSeq: number; idempotent: boolean }>("/v1/messages", {
      method: "POST",
      body: {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "hello from bot" } }],
        idempotencyKey: "bot-1",
      },
      principal: bot,
    });
    expect(first.body.streamSeq).toBe(1);

    const replay = await api<{ messageId: string; idempotent: boolean }>("/v1/messages", {
      method: "POST",
      body: {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "ignored" } }],
        idempotencyKey: "bot-1",
      },
      principal: bot,
    });
    expect(replay.body.idempotent).toBe(true);
    expect(replay.body.messageId).toBe(first.body.messageId);

    // 5. Non-member of a private channel cannot even observe it:
    //    attempting to post with autoRequestOnDeny still returns 403 because
    //    privacy is a hard boundary and runs before capability checks.
    const notMember = await api<{ error: string }>("/v1/messages", {
      method: "POST",
      body: {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "sneaky" } }],
        idempotencyKey: "u-sneaky",
        autoRequestOnDeny: true,
      },
      principal: user,
    });
    expect(notMember.status).toBe(403);

    // 6. Admin adds user as a channel member → privacy satisfied.
    await api(`/v1/channels/${channelId}/members`, {
      method: "POST",
      body: { actorId: user.actorId },
      principal: admin,
    });

    // 7. With membership but no message:append grant, autoRequestOnDeny now
    //    converts the denial into a permission request that admin can resolve.
    const deny = await api<{ denied: boolean; requestId: string; capability: string }>("/v1/messages", {
      method: "POST",
      body: {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "please" } }],
        idempotencyKey: "u-1",
        autoRequestOnDeny: true,
      },
      principal: user,
    });
    expect(deny.status).toBe(200);
    expect(deny.body.denied).toBe(true);
    expect(deny.body.capability).toBe("message:append");

    // 8. Admin approves → user retries successfully.
    const resolve = await api<{ status: string }>(`/v1/permission-requests/${deny.body.requestId}/resolve`, {
      method: "POST",
      body: { approve: true },
      principal: admin,
    });
    expect(resolve.body.status).toBe("approved");

    const userPost = await api<{ streamSeq: number }>("/v1/messages", {
      method: "POST",
      body: {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "user in" } }],
        idempotencyKey: "u-2",
      },
      principal: user,
    });
    expect(userPost.body.streamSeq).toBe(2);

    // 7. redact bot's first message; slot stays, parts gone
    const redact = await api(`/v1/messages/${first.body.messageId}/redact`, {
      method: "POST",
      body: { reason: "cleanup" },
      principal: bot,
    });
    expect(redact.status).toBe(200);
    const listed = await api<{ messages: Array<{ id: string; redacted: boolean; parts: unknown[]; streamSeq: number }> }>(
      `/v1/streams/${channelId}/messages`,
      { principal: admin },
    );
    const redactedRow = listed.body.messages.find((m) => m.id === first.body.messageId);
    expect(redactedRow?.redacted).toBe(true);
    expect(redactedRow?.parts).toEqual([]);
    expect(redactedRow?.streamSeq).toBe(1);

    // 8. create thread anchored to user's still-visible message
    const thread = await api<{ threadId: string }>("/v1/threads", {
      method: "POST",
      body: { channelId, parentMessageId: listed.body.messages[1].id },
      principal: admin,
    });
    expect(thread.status).toBe(200);

    // 9. cursor round-trip
    await api("/v1/cursors", {
      method: "POST",
      body: { streamId: channelId, lastSeenSeq: 2, lastAckSeq: 2 },
      principal: user,
    });
    const cur = await api<{ cursor: { lastSeenSeq: number } | null }>(
      `/v1/streams/${channelId}/cursor`,
      { principal: user },
    );
    expect(cur.body.cursor?.lastSeenSeq).toBe(2);

    // 10. grant check + client register
    const check = await api<{ hasGrant: boolean }>(
      `/v1/grants/check?actorId=${bot.actorId}&capability=message:append`,
      { principal: admin },
    );
    expect(check.body.hasGrant).toBe(true);
    const client = await api<{ clientId: string }>("/v1/clients", {
      method: "POST",
      body: { endpoint: "wss://fake/device-1", metadata: { platform: "ios" } },
      principal: admin,
    });
    expect(client.body.clientId).toMatch(/^[0-9a-f]{32}$/);

    // 11. audit export + verify
    const audit = await api<{ rows: Array<{ eventType: string }> }>("/v1/audit/rows", { principal: admin });
    expect(audit.body.rows.length).toBeGreaterThan(8);
    const verify = await api<{ valid: boolean }>("/v1/audit/verify", { principal: admin });
    expect(verify.body.valid).toBe(true);

    // 12. WebSocket replay + live push the same way the terminal ws-subscribe command does
    const wsUrl = `${baseUrl.replace(/^http/, "ws")}/v1/ws`;
    const ws = new NodeWebSocket(wsUrl, { headers: { "x-principal": JSON.stringify(admin) } });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "subscribe", streamId: channelId, streamType: "channel", fromSeq: 0 }));
    const firstEvent = await waitForWsMessage(ws, (m) => m.type === "event");
    expect((firstEvent.event as { type: string }).type).toBe("message.appended");

    const livePromise = waitForWsMessage(
      ws,
      (m) => m.type === "event" && (m.event as { streamSeq: number }).streamSeq === 3,
    );
    await api("/v1/messages", {
      method: "POST",
      body: {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "live-ws" } }],
        idempotencyKey: "live-ws",
      },
      principal: admin,
    });
    const live = await livePromise;
    expect((live.event as { streamSeq: number }).streamSeq).toBe(3);
    ws.close();
  });
});
