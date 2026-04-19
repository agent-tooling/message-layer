import type { MiddlewareHandler } from "hono";
import type { Context } from "hono";
import type { MessageLayerService } from "./service.js";
import type { StorageAdapter } from "./db.js";

export type ServerPluginContext = {
  service: MessageLayerService;
  adapter: StorageAdapter;
  env: NodeJS.ProcessEnv;
  useMiddleware: (middleware: MiddlewareHandler) => void;
  addRoute: (method: "GET" | "POST", path: string, handler: (c: Context) => Response | Promise<Response>) => void;
  logger: (message: string) => void;
};

export type ServerPlugin = {
  name: string;
  setup?: (ctx: ServerPluginContext) => void | Promise<void>;
};

export type PluginFactory = (options?: Record<string, unknown>) => ServerPlugin;

function requestLoggingPlugin(): ServerPlugin {
  return {
    name: "request-logging",
    setup(ctx) {
      ctx.useMiddleware(async (c, next) => {
        const start = Date.now();
        await next();
        const durationMs = Date.now() - start;
        ctx.logger(`${c.req.method} ${c.req.path} -> ${c.res.status} (${durationMs}ms)`);
      });
    },
  };
}

function healthMetaPlugin(options?: Record<string, unknown>): ServerPlugin {
  const includeAdapter = options?.includeAdapter !== false;
  return {
    name: "health-meta",
    setup(ctx) {
      ctx.addRoute("GET", "/health/meta", (c) =>
        c.json({
          ok: true,
          adapter: includeAdapter ? ctx.adapter : undefined,
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
      ctx.useMiddleware(async (c, next) => {
        const needsAuth = protectedPrefixes.some((prefix) => c.req.path.startsWith(prefix));
        if (!needsAuth) {
          await next();
          return;
        }
        const configuredKey = ctx.env[envKey];
        if (!configuredKey) {
          await next();
          return;
        }
        const sentKey = c.req.header(headerName);
        if (sentKey !== configuredKey) {
          c.status(401);
          c.header("content-type", "application/json");
          c.res = new Response(JSON.stringify({ error: "invalid api key" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
          return;
        }
        await next();
      });
    },
  };
}

export const builtInPluginFactories: Record<string, PluginFactory> = {
  "request-logging": requestLoggingPlugin,
  "health-meta": healthMetaPlugin,
  "api-key-header-auth": apiKeyHeaderAuthPlugin,
};

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
