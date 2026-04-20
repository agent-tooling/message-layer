import type { Hono } from "hono";
import type { ServerConfig } from "./config.js";
import type { EventBus } from "./event-bus.js";
import type { MessageLayerService } from "./service.js";
import type { DomainEvent } from "./types.js";

export type PluginLogger = (message: string) => unknown;

export type FetchHandler = (request: Request, ...args: unknown[]) => Promise<Response> | Response;
export type FetchWrapper = (next: FetchHandler) => FetchHandler;

export type PluginRuntimeContext = {
  app: Hono;
  service: MessageLayerService;
  bus: EventBus;
  config: ServerConfig;
  logger: PluginLogger;
  env: NodeJS.ProcessEnv;
  wrapFetch: (wrapper: FetchWrapper) => void;
};

export type ServerPlugin = {
  name: string;
  setup?: (ctx: PluginRuntimeContext) => void | Promise<void>;
  registerRoutes?: (ctx: PluginRuntimeContext) => void | Promise<void>;
  onEvent?: (event: DomainEvent, ctx: PluginRuntimeContext) => void | Promise<void>;
  dispose?: () => void | Promise<void>;
};

export type PluginFactory = (options?: Record<string, unknown>) => ServerPlugin;

// ── built-in plugins ───────────────────────────────────────────────────────

function requestLoggingPlugin(options?: Record<string, unknown>): ServerPlugin {
  const prefix = String(options?.prefix ?? "[ml]");
  return {
    name: "request-logging",
    setup(ctx) {
      ctx.wrapFetch((next) => async (request, ...args) => {
        const start = Date.now();
        const response = await next(request, ...args);
        const durationMs = Date.now() - start;
        const path = new URL(request.url).pathname;
        await ctx.logger(`${prefix} ${request.method} ${path} -> ${response.status} (${durationMs}ms)`);
        return response;
      });
    },
  };
}

function healthMetaPlugin(options?: Record<string, unknown>): ServerPlugin {
  const includeAdapter = options?.includeAdapter !== false;
  const version = typeof options?.version === "string" ? options.version : undefined;
  return {
    name: "health-meta",
    registerRoutes(ctx) {
      ctx.app.get("/health/meta", (c) =>
        c.json({
          ok: true,
          adapter: includeAdapter ? ctx.config.storage.adapter : undefined,
          version,
          plugins: ctx.config.plugins.map((p) => (typeof p === "string" ? p : p.name)),
        }),
      );
    },
  };
}

function apiKeyHeaderAuthPlugin(options?: Record<string, unknown>): ServerPlugin {
  const headerName = String(options?.headerName ?? "x-api-key");
  const envKey = String(options?.envKey ?? "MESSAGE_LAYER_API_KEY");
  const protectedPrefixes = Array.isArray(options?.protectedPrefixes)
    ? (options.protectedPrefixes as unknown[]).filter((v): v is string => typeof v === "string")
    : ["/v1/"];
  const strict = options?.strict === true;

  return {
    name: "api-key-header-auth",
    setup(ctx) {
      ctx.wrapFetch((next) => async (request, ...args) => {
        const path = new URL(request.url).pathname;
        const needsAuth = protectedPrefixes.some((prefix) => path.startsWith(prefix));
        if (!needsAuth) return next(request, ...args);
        const configuredKey = ctx.env[envKey];
        if (!configuredKey) {
          if (strict) {
            return new Response(JSON.stringify({ error: "api key not configured" }), {
              status: 503,
              headers: { "content-type": "application/json" },
            });
          }
          return next(request, ...args);
        }
        const sent = request.headers.get(headerName);
        if (sent !== configuredKey) {
          return new Response(JSON.stringify({ error: "invalid api key" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return next(request, ...args);
      });
    },
  };
}

function eventLoggerPlugin(options?: Record<string, unknown>): ServerPlugin {
  const prefix = String(options?.prefix ?? "[event]");
  let unsubscribe: (() => void) | undefined;
  return {
    name: "event-logger",
    setup(ctx) {
      unsubscribe = ctx.bus.subscribe((event) => {
        void ctx.logger(`${prefix} ${event.type} org=${event.orgId} streamSeq=${event.streamSeq ?? "-"}`);
      });
    },
    dispose() {
      unsubscribe?.();
    },
  };
}

function inMemoryKnowledgePlugin(options?: Record<string, unknown>): ServerPlugin {
  // A simple example plugin demonstrating the event subscription + route
  // contract. Stores a derived per-stream text index in memory and exposes a
  // read route. Only runs against events for channels the principal can
  // already read, because the route delegates privacy to the core service.
  const mountPath = typeof options?.mountPath === "string" ? options.mountPath : "/plugins/knowledge";
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

export const builtInPluginFactories: Record<string, PluginFactory> = {
  "request-logging": requestLoggingPlugin,
  "health-meta": healthMetaPlugin,
  "api-key-header-auth": apiKeyHeaderAuthPlugin,
  "event-logger": eventLoggerPlugin,
  "in-memory-knowledge": inMemoryKnowledgePlugin,
};

export type PluginSpec = string | { name: string; options?: Record<string, unknown> };

export function resolvePlugins(specs: PluginSpec[]): ServerPlugin[] {
  return instantiatePlugins(specs);
}

export function instantiatePlugins(specs: PluginSpec[]): ServerPlugin[] {
  return specs.map((spec) => {
    const name = typeof spec === "string" ? spec : spec.name;
    const options = typeof spec === "string" ? undefined : spec.options;
    const factory = builtInPluginFactories[name];
    if (!factory) {
      throw new Error(`unknown plugin: ${name}`);
    }
    return factory(options);
  });
}

export async function applyPluginsToApp(ctx: Omit<PluginRuntimeContext, "wrapFetch">, plugins: ServerPlugin[]): Promise<() => Promise<void>> {
  const appWithFetch = ctx.app as unknown as { fetch: FetchHandler };
  let currentFetch = appWithFetch.fetch.bind(ctx.app);
  const runtimeCtx: PluginRuntimeContext = {
    ...ctx,
    wrapFetch: (wrapper) => {
      currentFetch = wrapper(currentFetch);
      appWithFetch.fetch = currentFetch;
    },
  };

  // Cross-wire plugin `onEvent` into the shared bus. This keeps plugins
  // reactive without forcing every plugin to call `ctx.bus.subscribe` itself.
  const unsubs: Array<() => void> = [];
  for (const plugin of plugins) {
    if (plugin.onEvent) {
      const handler = plugin.onEvent.bind(plugin);
      unsubs.push(ctx.bus.subscribe((e) => handler(e, runtimeCtx)));
    }
  }

  for (const plugin of plugins) {
    await plugin.setup?.(runtimeCtx);
  }
  for (const plugin of plugins) {
    await plugin.registerRoutes?.(runtimeCtx);
  }

  return async () => {
    for (const unsub of unsubs) unsub();
    for (const plugin of plugins) {
      await plugin.dispose?.();
    }
  };
}

export const createPlugins = resolvePlugins;
