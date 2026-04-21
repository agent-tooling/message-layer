import type { EventBus } from "../event-bus.js";
import type { ServerPlugin } from "../plugins.js";
import type { MessageLayerService } from "../service.js";
import { attachWebSocketServer, type WebSocketServerHandle } from "../ws.js";

export type WebSocketPluginOptions = {
  /**
   * WebSocket endpoint path.
   * Defaults to `"/v1/ws"`.
   */
  path?: string;
};

/**
 * Attaches a WebSocket server to the HTTP server after it is bound to a port.
 *
 * Clients connect to `ws[s]://<host>/v1/ws` (or a custom path) and use the
 * JSON protocol defined in the core `ws.ts` module:
 *
 * ```
 * → { "type": "subscribe",   "streamId": "…", "streamType": "channel|thread", "fromSeq": 0 }
 * → { "type": "unsubscribe", "streamId": "…" }
 * → { "type": "ping" }
 *
 * ← { "type": "welcome",    "actorId", "orgId" }
 * ← { "type": "subscribed", "streamId", "lastSeq" }
 * ← { "type": "event",      "event": { … } }
 * ← { "type": "pong" }
 * ← { "type": "error",      "error": "…" }
 * ```
 *
 * @example
 * ```typescript
 * import { startServer } from "message-layer";
 * import { websocketPlugin } from "message-layer/plugins/websocket";
 *
 * await startServer({
 *   plugins: [websocketPlugin()],
 * });
 * ```
 */
export function websocketPlugin(options: WebSocketPluginOptions = {}): ServerPlugin {
  let handle: WebSocketServerHandle | null = null;
  let capturedService: MessageLayerService | null = null;
  let capturedBus: EventBus | null = null;

  return {
    name: "websocket",

    setup(ctx) {
      capturedService = ctx.service;
      capturedBus = ctx.bus;
    },

    onServerBound(server) {
      if (!capturedService || !capturedBus) {
        throw new Error("websocket plugin: setup was not called before onServerBound");
      }
      handle = attachWebSocketServer(server, capturedService, capturedBus, {
        path: options.path,
      });
    },

    async dispose() {
      await handle?.close();
      handle = null;
    },
  };
}

/** @deprecated Pass typed options directly: `websocketPlugin()` */
export const websocketPluginFactory = (options?: Record<string, unknown>): ServerPlugin =>
  websocketPlugin({ path: typeof options?.path === "string" ? options.path : undefined });
