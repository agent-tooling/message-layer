import type { ServerPlugin } from "../plugins.js";

export type RequestLoggingOptions = {
  /** Prefix prepended to every log line. Defaults to `"[ml]"`. */
  prefix?: string;
};

export function requestLoggingPlugin(options: RequestLoggingOptions = {}): ServerPlugin {
  const prefix = options.prefix ?? "[ml]";
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

/** @deprecated Pass typed options directly: `requestLoggingPlugin({ prefix: "..." })` */
export const requestLoggingPluginFactory = (options?: Record<string, unknown>): ServerPlugin =>
  requestLoggingPlugin({ prefix: typeof options?.prefix === "string" ? options.prefix : undefined });
