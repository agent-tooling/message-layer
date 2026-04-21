import type { ServerPlugin } from "../plugins.js";

export type HealthMetaOptions = {
  /** Include the storage adapter name in the response. Defaults to `true`. */
  includeAdapter?: boolean;
  /** Optional version string to expose in `/health/meta`. */
  version?: string;
};

export function healthMetaPlugin(options: HealthMetaOptions = {}): ServerPlugin {
  const includeAdapter = options.includeAdapter !== false;
  const version = options.version;
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

/** @deprecated Pass typed options directly: `healthMetaPlugin({ version: "..." })` */
export const healthMetaPluginFactory = (options?: Record<string, unknown>): ServerPlugin =>
  healthMetaPlugin({
    includeAdapter: options?.includeAdapter !== false,
    version: typeof options?.version === "string" ? options.version : undefined,
  });
