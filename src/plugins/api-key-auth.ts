import type { ServerPlugin } from "../plugins.js";

export type ApiKeyAuthOptions = {
  /**
   * Request header the client sends the key in.
   * Defaults to `"x-api-key"`.
   */
  headerName?: string;
  /**
   * Environment variable holding the expected secret.
   * Defaults to `"MESSAGE_LAYER_API_KEY"`.
   */
  envKey?: string;
  /**
   * URL path prefixes that require authentication.
   * Defaults to `["/v1/"]`.
   */
  protectedPrefixes?: string[];
  /**
   * When `true`, return `503 Service Unavailable` if the env variable is not
   * set instead of letting requests through. Recommended for production to
   * catch misconfigured deployments.
   */
  strict?: boolean;
};

export function apiKeyAuthPlugin(options: ApiKeyAuthOptions = {}): ServerPlugin {
  const headerName = options.headerName ?? "x-api-key";
  const envKey = options.envKey ?? "MESSAGE_LAYER_API_KEY";
  const protectedPrefixes = options.protectedPrefixes ?? ["/v1/"];
  const strict = options.strict === true;

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

/** @deprecated Pass typed options directly: `apiKeyAuthPlugin({ strict: true })` */
export const apiKeyAuthPluginFactory = (options?: Record<string, unknown>): ServerPlugin =>
  apiKeyAuthPlugin({
    headerName: typeof options?.headerName === "string" ? options.headerName : undefined,
    envKey: typeof options?.envKey === "string" ? options.envKey : undefined,
    protectedPrefixes: Array.isArray(options?.protectedPrefixes)
      ? (options.protectedPrefixes as string[])
      : undefined,
    strict: options?.strict === true,
  });
