import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { startServer, type RunningServer } from "../../src/server-runtime.js";
import type { Principal } from "../../src/types.js";

type WsMessage = { type: string } & Record<string, unknown>;

async function http<T = unknown>(
  server: RunningServer,
  method: "GET" | "POST",
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
  return { status: res.status, body: text ? (JSON.parse(text) as T) : ({} as T) };
}

function openWs(url: string, principal: Principal): Promise<{
  ws: NodeWebSocket;
  next: (predicate: (m: WsMessage) => boolean, timeoutMs?: number) => Promise<WsMessage>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new NodeWebSocket(url, { headers: { "x-principal": JSON.stringify(principal) } });
    const buffered: WsMessage[] = [];
    const waiters: Array<{
      predicate: (m: WsMessage) => boolean;
      resolve: (m: WsMessage) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];
    ws.on("message", (raw: NodeWebSocket.RawData) => {
      const msg = JSON.parse(raw.toString()) as WsMessage;
      const idx = waiters.findIndex((w) => w.predicate(msg));
      if (idx >= 0) {
        const [w] = waiters.splice(idx, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        buffered.push(msg);
      }
    });
    ws.once("open", () => {
      resolve({
        ws,
        close: () => ws.close(),
        next: (predicate, timeoutMs = 2500) =>
          new Promise<WsMessage>((res, rej) => {
            const existing = buffered.findIndex((m) => predicate(m));
            if (existing >= 0) {
              const [msg] = buffered.splice(existing, 1);
              res(msg);
              return;
            }
            const timer = setTimeout(() => rej(new Error("timeout")), timeoutMs);
            waiters.push({ predicate, resolve: res, timer });
          }),
      });
    });
    ws.once("error", reject);
  });
}

async function startSink(): Promise<{
  url: string;
  deliveries: Array<{ eventType: string | null; streamId: string | null }>;
  close: () => Promise<void>;
}> {
  const deliveries: Array<{ eventType: string | null; streamId: string | null }> = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      parsed = {};
    }
    const event = (
      parsed &&
      typeof parsed === "object" &&
      "event" in parsed &&
      (parsed as { event?: unknown }).event &&
      typeof (parsed as { event?: unknown }).event === "object"
    ) ? (parsed as { event: { type?: string; streamId?: string | null } }).event : null;
    deliveries.push({ eventType: event?.type ?? null, streamId: event?.streamId ?? null });
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("sink start failed");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    deliveries,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

describe("privacy transport conformance", () => {
  let server: RunningServer | undefined;
  let sink: Awaited<ReturnType<typeof startSink>> | undefined;

  afterEach(async () => {
    await server?.close();
    await sink?.close();
    server = undefined;
    sink = undefined;
  });

  test("non-member private stream access is consistently denied across transports", async () => {
    sink = await startSink();
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        port: 0,
        storage: { adapter: "pglite", path: `memory://privacy-transport-${Math.random().toString(16).slice(2)}` },
        artifacts: { kind: "memory" },
        plugins: [
          { name: "webhooks", options: { allowPrivateNetworks: true } },
          "durable-streams",
          "websocket",
        ],
      },
    });

    const org = await http<{ orgId: string }>(server, "POST", "/v1/orgs", null, { name: "transport-org" });
    const adminActor = await http<{ actorId: string }>(server, "POST", "/v1/actors", null, {
      orgId: org.body.orgId,
      actorType: "human",
      displayName: "admin",
    });
    const outsiderActor = await http<{ actorId: string }>(server, "POST", "/v1/actors", null, {
      orgId: org.body.orgId,
      actorType: "human",
      displayName: "outsider",
    });

    const admin: Principal = {
      actorId: adminActor.body.actorId,
      orgId: org.body.orgId,
      scopes: ["channel:create", "channel:admin", "message:append", "grant:create"],
      provider: "test",
    };
    const outsider: Principal = {
      actorId: outsiderActor.body.actorId,
      orgId: org.body.orgId,
      scopes: ["webhook:subscribe", "webhook:read"],
      provider: "test",
    };

    const privateChannel = await http<{ channelId: string }>(server, "POST", "/v1/channels", admin, {
      name: "private-room",
      visibility: "private",
    });
    const publicChannel = await http<{ channelId: string }>(server, "POST", "/v1/channels", admin, {
      name: "public-room",
      visibility: "public",
    });

    const ds = await http<{ durableStreamId: string }>(server, "POST", "/v1/durable-streams", admin, {
      targetStreamId: privateChannel.body.channelId,
      targetStreamType: "channel",
    });
    expect(ds.status).toBe(200);
    const grant = await http<{ grantId: string }>(server, "POST", "/v1/grants", admin, {
      actorId: outsider.actorId,
      resourceType: "org",
      resourceId: outsider.orgId,
      capability: "durable_stream:read",
    });
    expect(grant.status).toBe(200);

    const sub = await http<{ subscriptionId: string }>(server, "POST", "/v1/webhooks/subscriptions", outsider, {
      endpoint: `${sink.url}/hook`,
      eventTypes: ["message.appended"],
    });
    expect(sub.status).toBe(200);

    const httpDenied = await http(server, "GET", `/v1/streams/${privateChannel.body.channelId}/messages`, outsider);
    expect(httpDenied.status).toBe(403);

    const ws = await openWs(`ws://127.0.0.1:${server.port}/v1/ws`, outsider);
    await ws.next((m) => m.type === "welcome");
    ws.ws.send(JSON.stringify({ type: "subscribe", streamId: privateChannel.body.channelId, streamType: "channel" }));
    const wsDenied = await ws.next((m) => m.type === "error", 3000);
    expect(wsDenied.code).toBe("PERMISSION_DENIED");
    ws.close();

    const durableDenied = await http(server, "GET", `/v1/durable-streams/${ds.body.durableStreamId}/head`, outsider);
    expect(durableDenied.status).toBe(403);

    await http(server, "POST", "/v1/messages", admin, {
      streamId: privateChannel.body.channelId,
      streamType: "channel",
      idempotencyKey: "transport-private-1",
      parts: [{ type: "text", payload: { text: "private transport payload" } }],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sink.deliveries.length).toBe(0);

    await http(server, "POST", "/v1/messages", admin, {
      streamId: publicChannel.body.channelId,
      streamType: "channel",
      idempotencyKey: "transport-public-1",
      parts: [{ type: "text", payload: { text: "public transport payload" } }],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sink.deliveries.length).toBe(1);
    expect(sink.deliveries[0]?.streamId).toBe(publicChannel.body.channelId);
  });
});
