import type { Hono } from "hono";
import type { ServerConfig } from "./config.js";
import type { SqlDatabase } from "./db.js";
import type { EventBus } from "./event-bus.js";
import type { MessageLayerService } from "./service.js";
import { apiKeyAuthPluginFactory } from "./plugins/api-key-auth.js";
import { durableStreamsPlugin } from "./plugins/durable-streams.js";
import { eventLoggerPluginFactory } from "./plugins/event-logger.js";
import { healthMetaPluginFactory } from "./plugins/health-meta.js";
import { inMemoryKnowledgePluginFactory } from "./plugins/in-memory-knowledge.js";
import { requestLoggingPluginFactory } from "./plugins/request-logging.js";
import { scopedKnowledgePlugin } from "./plugins/scoped-knowledge.js";
import { webhookPlugin } from "./plugins/webhooks.js";
import { websocketPluginFactory } from "./plugins/websocket.js";
import { durableStreamsStoragePlugin } from "./plugins/durable-streams-storage.js";
import type { DomainEvent } from "./types.js";

export type PluginLogger = (message: string) => unknown;

export type FetchHandler = (request: Request, ...args: unknown[]) => Promise<Response> | Response;
export type FetchWrapper = (next: FetchHandler) => FetchHandler;

export type PluginRuntimeContext = {
  app: Hono;
  db: SqlDatabase;
  service: MessageLayerService;
  bus: EventBus;
  config: ServerConfig;
  logger: PluginLogger;
  env: NodeJS.ProcessEnv;
  wrapFetch: (wrapper: FetchWrapper) => void;
};

export type PluginSchemaDef = {
  name: string;
  sql: string[];
};

export type ServerPlugin = {
  name: string;
  schemaSql?: PluginSchemaDef | PluginSchemaDef[];
  setup?: (ctx: PluginRuntimeContext) => void | Promise<void>;
  registerRoutes?: (ctx: PluginRuntimeContext) => void | Promise<void>;
  onEvent?: (event: DomainEvent, ctx: PluginRuntimeContext) => void | Promise<void>;
  /**
   * Called after the HTTP server is bound to a port. Use this hook when the
   * plugin needs the live `http.Server` instance — e.g. to attach a WebSocket
   * server via `server.on("upgrade", ...)`.
   *
   * Capture any context from `setup` via closure; the plugin system does not
   * re-pass `PluginRuntimeContext` here since it is too late to wrap fetch.
   */
  onServerBound?: (server: import("node:http").Server) => void | Promise<void>;
  dispose?: () => void | Promise<void>;
};

export type PluginFactory = (options?: Record<string, unknown>) => ServerPlugin;

// ── built-in plugin registry ───────────────────────────────────────────────

export const builtInPluginFactories: Record<string, PluginFactory> = {
  "request-logging": requestLoggingPluginFactory,
  "health-meta": healthMetaPluginFactory,
  "api-key-header-auth": apiKeyAuthPluginFactory,
  "event-logger": eventLoggerPluginFactory,
  "in-memory-knowledge": inMemoryKnowledgePluginFactory,
  "scoped-knowledge": scopedKnowledgePlugin,
  webhooks: webhookPlugin,
  "durable-streams": durableStreamsPlugin,
  "durable-streams-storage": durableStreamsStoragePlugin,
  websocket: websocketPluginFactory,
};

export type PluginSpec = string | { name: string; options?: Record<string, unknown> } | ServerPlugin;

/**
 * Returns `true` when a spec is already an instantiated `ServerPlugin`
 * (e.g. the result of calling `requestLoggingPlugin()` directly) rather than
 * a string name or a `{ name, options }` descriptor.
 *
 * Detection: a descriptor only ever has `name` + `options`. An instantiated
 * plugin has `name` plus at least one lifecycle method.
 */
function isPluginInstance(spec: PluginSpec): spec is ServerPlugin {
  if (typeof spec === "string") return false;
  const s = spec as Partial<ServerPlugin>;
  return (
    typeof s.setup === "function" ||
    typeof s.registerRoutes === "function" ||
    typeof s.onEvent === "function" ||
    typeof s.onServerBound === "function" ||
    typeof s.dispose === "function" ||
    s.schemaSql !== undefined
  );
}

export function resolvePlugins(specs: PluginSpec[]): ServerPlugin[] {
  return instantiatePlugins(specs);
}

export function instantiatePlugins(specs: PluginSpec[]): ServerPlugin[] {
  return specs.map((spec) => {
    // Already-instantiated plugin — pass through unchanged.
    if (isPluginInstance(spec)) return spec;

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

export async function notifyPluginsServerBound(
  plugins: ServerPlugin[],
  server: import("node:http").Server,
): Promise<void> {
  for (const plugin of plugins) {
    await plugin.onServerBound?.(server);
  }
}

export async function applyPluginSchemas(
  db: SqlDatabase,
  plugins: ServerPlugin[],
  logger: PluginLogger = () => {},
): Promise<void> {
  for (const plugin of plugins) {
    const defs = plugin.schemaSql
      ? (Array.isArray(plugin.schemaSql) ? plugin.schemaSql : [plugin.schemaSql])
      : [];
    for (const def of defs) {
      for (const statement of def.sql) {
        const sql = statement.trim();
        if (!sql) continue;
        await db.query(sql);
      }
      logger(`[plugin-schema] ${plugin.name}/${def.name} applied`);
    }
  }
}

export const createPlugins = resolvePlugins;
