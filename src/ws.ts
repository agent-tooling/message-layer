import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { EventBus } from "./event-bus.js";
import type { MessageLayerService } from "./service.js";
import {
  NotFoundError,
  PermissionError,
  principalSchema,
  streamTypeSchema,
  type DomainEvent,
  type Principal,
  type StreamType,
} from "./types.js";
import { isWebSocketEventDeliverable } from "./event-support.js";

export type WebSocketServerHandle = {
  wss: WebSocketServer;
  close: () => Promise<void>;
};

type SubscribeMessage = {
  type: "subscribe";
  streamId: string;
  streamType?: StreamType;
  fromSeq?: number;
};

type UnsubscribeMessage = { type: "unsubscribe"; streamId: string };
type PingMessage = { type: "ping" };

type ClientMessage = SubscribeMessage | UnsubscribeMessage | PingMessage;

type Subscription = {
  streamId: string;
  streamType: StreamType;
  unsubscribe: () => void;
};

/**
 * Attaches a WebSocket server to an existing HTTP server at `/v1/ws`.
 *
 * Clients handshake with the same `x-principal` header used by HTTP requests
 * (or a `?principal=<encoded json>` query param for environments that can't
 * set headers on upgrade). Once connected, clients send JSON messages to
 * manage subscriptions:
 *
 * ```
 * { type: "subscribe", streamId, streamType?, fromSeq? }
 * { type: "unsubscribe", streamId }
 * { type: "ping" }
 * ```
 *
 * The server pushes messages of shape `{ type: "event", event: DomainEvent }`
 * for every live event on a subscribed stream, after first replaying any
 * events with `streamSeq > fromSeq` from the DB.
 */
export function attachWebSocketServer(
  httpServer: HttpServer,
  service: MessageLayerService,
  bus: EventBus,
  options: { path?: string } = {},
): WebSocketServerHandle {
  const path = options.path ?? "/v1/ws";
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) return;

    const principal = extractPrincipal(req, url);
    if (!principal) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleConnection(ws, principal, service, bus);
    });
  };

  httpServer.on("upgrade", onUpgrade);

  return {
    wss,
    close: async () => {
      httpServer.off("upgrade", onUpgrade);
      for (const client of wss.clients) {
        try {
          client.close(1000, "server closing");
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

function extractPrincipal(req: IncomingMessage, url: URL): Principal | null {
  const headerValue = req.headers["x-principal"];
  const headerStr = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (headerStr) {
    try {
      const parsed = JSON.parse(headerStr);
      const result = principalSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // fall through to query param
    }
  }
  const queryValue = url.searchParams.get("principal");
  if (queryValue) {
    try {
      const parsed = JSON.parse(queryValue);
      const result = principalSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // ignore
    }
  }
  return null;
}

async function handleConnection(
  ws: WebSocket,
  principal: Principal,
  service: MessageLayerService,
  bus: EventBus,
): Promise<void> {
  const subscriptions = new Map<string, Subscription>();

  const cleanup = () => {
    for (const sub of subscriptions.values()) sub.unsubscribe();
    subscriptions.clear();
  };

  const safeSend = (payload: unknown) => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // ignore transient send failures; the socket will close on its own
    }
  };

  ws.on("message", async (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      safeSend({ type: "error", error: "invalid json" });
      return;
    }

    try {
      if (msg.type === "ping") {
        safeSend({ type: "pong" });
        return;
      }

      if (msg.type === "subscribe") {
        if (subscriptions.has(msg.streamId)) {
          safeSend({ type: "error", error: "already subscribed", streamId: msg.streamId });
          return;
        }
        const streamType = msg.streamType ? streamTypeSchema.parse(msg.streamType) : undefined;
        const fromSeq = msg.fromSeq ?? 0;

        // This throws PermissionError/NotFoundError if the actor can't read.
        const replay = await service.subscribe(principal, msg.streamId, { streamType, fromSeq });
        const resolvedStreamType: StreamType = streamType ?? (replay[0]?.streamSeq !== undefined ? await inferStreamType(service, msg.streamId) : await inferStreamType(service, msg.streamId));

        let lastSeq = fromSeq;
        for (const e of replay) {
          if (!isWebSocketEventDeliverable(e)) continue;
          safeSend({ type: "event", event: e });
          if (e.streamSeq !== null) lastSeq = Math.max(lastSeq, e.streamSeq);
        }

        let active = true;
        const unsubscribe = bus.subscribe((event: DomainEvent) => {
          if (!active) return;
          void (async () => {
            if (!isWebSocketEventDeliverable(event)) return;
            if (event.streamId !== msg.streamId) return;
            if (event.orgId !== principal.orgId) return;
            if (event.streamSeq !== null && event.streamSeq <= lastSeq) return;
            try {
              // Re-check readability on each event so membership revocations on
              // private streams take effect immediately for live sockets.
              await service.assertCanReadStream(principal, msg.streamId, resolvedStreamType);
            } catch (error) {
              active = false;
              unsubscribe();
              subscriptions.delete(msg.streamId);
              if (error instanceof PermissionError) {
                safeSend({ type: "error", error: error.message, code: "PERMISSION_DENIED", streamId: msg.streamId });
              } else {
                safeSend({ type: "error", error: "subscription revoked", code: "PERMISSION_DENIED", streamId: msg.streamId });
              }
              safeSend({ type: "unsubscribed", streamId: msg.streamId });
              return;
            }
            if (event.streamSeq !== null) lastSeq = event.streamSeq;
            safeSend({ type: "event", event });
          })();
        });
        subscriptions.set(msg.streamId, { streamId: msg.streamId, streamType: resolvedStreamType, unsubscribe });
        safeSend({ type: "subscribed", streamId: msg.streamId, lastSeq });
        return;
      }

      if (msg.type === "unsubscribe") {
        const sub = subscriptions.get(msg.streamId);
        if (sub) {
          sub.unsubscribe();
          subscriptions.delete(msg.streamId);
        }
        safeSend({ type: "unsubscribed", streamId: msg.streamId });
        return;
      }

      safeSend({ type: "error", error: "unknown message type" });
    } catch (error) {
      if (error instanceof PermissionError) {
        safeSend({ type: "error", error: error.message, code: "PERMISSION_DENIED" });
      } else if (error instanceof NotFoundError) {
        safeSend({ type: "error", error: error.message, code: "NOT_FOUND" });
      } else if (error instanceof Error) {
        safeSend({ type: "error", error: error.message });
      } else {
        safeSend({ type: "error", error: "unexpected error" });
      }
    }
  });

  ws.on("close", cleanup);
  ws.on("error", cleanup);

  safeSend({ type: "welcome", actorId: principal.actorId, orgId: principal.orgId });
}

async function inferStreamType(service: MessageLayerService, streamId: string): Promise<StreamType> {
  // Use a synthetic admin-style principal? No: just query the DB via service.
  // `subscribe` already ran, so the stream exists; we just need to know which.
  // This is a tiny helper that duplicates the service's inference logic, but
  // keeps `inferStreamType` private. Use a lightweight db query.
  const dbResult = await service.db.query<{ id: string }>("SELECT id FROM channels WHERE id=?", [streamId]);
  if (dbResult.rows[0]) return "channel";
  return "thread";
}
