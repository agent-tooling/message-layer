import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { startServer, type RunningServer } from "../../src/server-runtime.js";
import { defaultServerConfig } from "../../src/config.js";
import type { Principal } from "../../src/types.js";

let server: RunningServer;

beforeEach(async () => {
  server = await startServer({
    port: 0,
    logger: () => {},
    config: { ...defaultServerConfig({}), plugins: [], websocket: true, port: 0 },
  });
});
afterEach(async () => {
  await server.close();
});

async function bootstrap(): Promise<{ orgId: string; admin: Principal; channelId: string }> {
  const orgId = await server.service.createOrg("Acme");
  const adminId = await server.service.createActor(orgId, "human", "admin");
  const admin: Principal = {
    actorId: adminId,
    orgId,
    scopes: ["grant:create", "channel:create", "message:append"],
    provider: "test",
  };
  const channelId = await server.service.createChannel(admin, "general", "public");
  return { orgId, admin, channelId };
}

type WsMessage = { type: string } & Record<string, unknown>;

type WsHandle = {
  ws: NodeWebSocket;
  next: (predicate: (m: WsMessage) => boolean, timeoutMs?: number) => Promise<WsMessage>;
  close: () => void;
};

function openWs(url: string, principal: Principal): Promise<WsHandle> {
  return new Promise((resolve, reject) => {
    const ws = new NodeWebSocket(url, {
      headers: { "x-principal": JSON.stringify(principal) },
    });
    const buffered: WsMessage[] = [];
    const waiters: Array<{ predicate: (m: WsMessage) => boolean; resolve: (m: WsMessage) => void; timer: ReturnType<typeof setTimeout> }> = [];
    ws.on("message", (raw: NodeWebSocket.RawData) => {
      const m = JSON.parse(raw.toString()) as WsMessage;
      const idx = waiters.findIndex((w) => w.predicate(m));
      if (idx >= 0) {
        const [w] = waiters.splice(idx, 1);
        clearTimeout(w.timer);
        w.resolve(m);
      } else {
        buffered.push(m);
      }
    });
    ws.once("open", () =>
      resolve({
        ws,
        close: () => ws.close(),
        next: (predicate, timeoutMs = 2000) =>
          new Promise<WsMessage>((res, rej) => {
            const existing = buffered.findIndex((m) => predicate(m));
            if (existing >= 0) {
              const [m] = buffered.splice(existing, 1);
              res(m);
              return;
            }
            const timer = setTimeout(() => rej(new Error("timeout waiting for message")), timeoutMs);
            waiters.push({ predicate, resolve: res, timer });
          }),
      }),
    );
    ws.once("error", reject);
  });
}

describe("WebSocket transport", () => {
  test("connects, subscribes, replays, receives live events, unsubscribes", async () => {
    const { admin, channelId } = await bootstrap();

    // Pre-create one message so we have a replayable event
    await server.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "before-ws" } }],
      idempotencyKey: "pre-1",
    });

    const handle = await openWs(`ws://127.0.0.1:${server.port}/v1/ws`, admin);

    await handle.next((m) => m.type === "welcome");
    handle.ws.send(JSON.stringify({ type: "subscribe", streamId: channelId, streamType: "channel", fromSeq: 0 }));

    const replay = await handle.next((m) => m.type === "event");
    expect((replay.event as { type: string }).type).toBe("message.appended");

    const subscribed = await handle.next((m) => m.type === "subscribed");
    expect(subscribed.streamId).toBe(channelId);

    const livePromise = handle.next(
      (m) => m.type === "event" && (m.event as { streamSeq: number }).streamSeq === 2,
      3000,
    );
    await server.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "live" } }],
      idempotencyKey: "live-1",
    });
    const live = await livePromise;
    expect((live.event as { streamSeq: number }).streamSeq).toBe(2);

    handle.ws.send(JSON.stringify({ type: "unsubscribe", streamId: channelId }));
    await handle.next((m) => m.type === "unsubscribed");
    handle.close();
  });

  test("rejects upgrade without principal", async () => {
    const failure = new Promise<boolean>((resolve) => {
      const ws = new NodeWebSocket(`ws://127.0.0.1:${server.port}/v1/ws`);
      ws.once("open", () => resolve(false));
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode === 401);
        res.destroy();
      });
      ws.once("error", () => resolve(true));
    });
    expect(await failure).toBe(true);
  });

  test("private channel subscribe is denied for non-members", async () => {
    const { orgId, admin } = await bootstrap();
    const priv = await server.service.createChannel(admin, "secret", "private");
    const bobActorId = await server.service.createActor(orgId, "human", "bob");
    const bob: Principal = { actorId: bobActorId, orgId, scopes: [], provider: "test" };

    const handle = await openWs(`ws://127.0.0.1:${server.port}/v1/ws`, bob);
    await handle.next((m) => m.type === "welcome");
    handle.ws.send(JSON.stringify({ type: "subscribe", streamId: priv, streamType: "channel" }));
    const err = await handle.next((m) => m.type === "error");
    expect(err.code).toBe("PERMISSION_DENIED");
    handle.close();
  });

  test("ping → pong round trip", async () => {
    const { admin } = await bootstrap();
    const handle = await openWs(`ws://127.0.0.1:${server.port}/v1/ws`, admin);
    await handle.next((m) => m.type === "welcome");
    handle.ws.send(JSON.stringify({ type: "ping" }));
    const pong = await handle.next((m) => m.type === "pong");
    expect(pong.type).toBe("pong");
    handle.close();
  });
});
