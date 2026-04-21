import type { ServerPlugin } from "../plugins.js";

export type InMemoryKnowledgeOptions = {
  /**
   * Mount path for the knowledge route.
   * Defaults to `"/plugins/knowledge"`.
   */
  mountPath?: string;
};

/**
 * Lightweight in-memory message index built from `message.appended` events.
 *
 * Retained for plugin-authoring examples and backward compatibility.
 * Use `scoped-knowledge` for production — it persists across restarts,
 * enforces source-stream privacy, and supports org-wide promotion.
 */
export function inMemoryKnowledgePlugin(options: InMemoryKnowledgeOptions = {}): ServerPlugin {
  const mountPath = options.mountPath ?? "/plugins/knowledge";
  const perStream = new Map<string, string[]>();
  let unsubscribe: (() => void) | undefined;
  return {
    name: "in-memory-knowledge",
    setup(ctx) {
      unsubscribe = ctx.bus.subscribe((event) => {
        if (event.type !== "message.appended") return;
        const streamId = event.streamId;
        if (!streamId) return;
        const payload = event.payload as { messageId?: string };
        if (!payload.messageId) return;
        const list = perStream.get(streamId) ?? [];
        list.push(payload.messageId);
        perStream.set(streamId, list);
      });
    },
    registerRoutes(ctx) {
      ctx.app.get(`${mountPath}/:streamId`, (c) => {
        const { streamId } = c.req.param();
        return c.json({ streamId, messageIds: perStream.get(streamId) ?? [] });
      });
    },
    dispose() {
      unsubscribe?.();
    },
  };
}

/** @deprecated Pass typed options directly: `inMemoryKnowledgePlugin({ mountPath: "..." })` */
export const inMemoryKnowledgePluginFactory = (options?: Record<string, unknown>): ServerPlugin =>
  inMemoryKnowledgePlugin({
    mountPath: typeof options?.mountPath === "string" ? options.mountPath : undefined,
  });
