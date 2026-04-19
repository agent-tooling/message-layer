import type { Hono } from "hono";
import type { Context } from "hono";
import type { MessageLayerService } from "./service.js";
import type { ServerConfig } from "./config.js";

export type PluginRuntimeContext = {
  app: Hono;
  service: MessageLayerService;
  config: ServerConfig;
  logger: (message: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  wrapFetch?: (
    wrapper: (
      next: (request: Request, ...args: unknown[]) => Promise<Response> | Response,
    ) => (request: Request, ...args: unknown[]) => Promise<Response> | Response,
  ) => void;
};

export type ServerPlugin = {
  name: string;
  setup?: (ctx: PluginRuntimeContext) => void | Promise<void>;
  registerRoutes?: (ctx: PluginRuntimeContext) => void | Promise<void>;
};

export type PluginFactory = (options?: Record<string, unknown>) => ServerPlugin;

function requestLoggingPlugin(): ServerPlugin {
  return {
    name: "request-logging",
    setup(ctx) {
      ctx.wrapFetch?.((next) => async (request, ...args) => {
        const start = Date.now();
        const response = await next(request, ...args);
        const durationMs = Date.now() - start;
        const path = new URL(request.url).pathname;
        await ctx.logger(`${request.method} ${path} -> ${response.status} (${durationMs}ms)`);
        return response;
      });
    },
  };
}

function healthMetaPlugin(options?: Record<string, unknown>): ServerPlugin {
  const includeAdapter = options?.includeAdapter !== false;
  return {
    name: "health-meta",
    registerRoutes(ctx) {
      ctx.app.get("/health/meta", (c) =>
        c.json({
          ok: true,
          adapter: includeAdapter ? ctx.config.storage.adapter : undefined,
        }),
      );
    },
  };
}

function apiKeyHeaderAuthPlugin(options?: Record<string, unknown>): ServerPlugin {
  const headerName = String(options?.headerName ?? "x-api-key");
  const envKey = String(options?.envKey ?? "MESSAGE_LAYER_API_KEY");
  const protectedPrefixes = Array.isArray(options?.protectedPrefixes)
    ? options.protectedPrefixes.filter((v): v is string => typeof v === "string")
    : ["/v1/"];

  return {
    name: "api-key-header-auth",
    setup(ctx) {
      ctx.wrapFetch?.((next) => async (request, ...args) => {
        const path = new URL(request.url).pathname;
        const needsAuth = protectedPrefixes.some((prefix) => path.startsWith(prefix));
        if (!needsAuth) {
          return next(request, ...args);
        }
        const configuredKey = (ctx.env ?? process.env)[envKey];
        if (!configuredKey) {
          return next(request, ...args);
        }
        const sentKey = request.headers.get(headerName);
        if (sentKey !== configuredKey) {
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

export const builtInPluginFactories: Record<string, PluginFactory> = {
  "request-logging": requestLoggingPlugin,
  "health-meta": healthMetaPlugin,
  "api-key-header-auth": apiKeyHeaderAuthPlugin,
};

type PluginSpec = string | { name: string; options?: Record<string, unknown> };

export function resolvePlugins(
  pluginSpecs: PluginSpec[],
): ServerPlugin[] {
  return instantiatePlugins(pluginSpecs);
}

export function instantiatePlugins(
  pluginSpecs: Array<string | { name: string; options?: Record<string, unknown> }>,
): ServerPlugin[] {
  return pluginSpecs.map((spec) => {
    const name = typeof spec === "string" ? spec : spec.name;
    const options = typeof spec === "string" ? undefined : spec.options;
    const factory = builtInPluginFactories[name];
    if (!factory) {
      throw new Error(`unknown plugin: ${name}`);
    }
    return factory(options);
  });
}

export async function runPluginSetup(plugins: ServerPlugin[], ctx: PluginRuntimeContext): Promise<void> {
  for (const plugin of plugins) {
    await plugin.setup?.(ctx);
  }
}

export async function applyPluginsToApp(ctx: PluginRuntimeContext, plugins: ServerPlugin[]): Promise<void> {
  const appWithFetch = ctx.app as unknown as {
    fetch: (request: Request, ...args: unknown[]) => Promise<Response> | Response;
  };
  let currentFetch = appWithFetch.fetch.bind(ctx.app);
  const wrapFetch: PluginRuntimeContext["wrapFetch"] = (wrapper) => {
    currentFetch = wrapper(currentFetch);
    appWithFetch.fetch = currentFetch;
  };
  const runtimeCtx: PluginRuntimeContext = { ...ctx, wrapFetch };
  await runPluginSetup(plugins, runtimeCtx);
  for (const plugin of plugins) {
    await plugin.registerRoutes?.(runtimeCtx);
  }
}

export const createPlugins = resolvePlugins;
