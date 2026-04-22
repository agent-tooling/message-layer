import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
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

/**
 * Constant-time string comparison. Returns `false` when lengths differ without
 * leaking the expected length, and otherwise performs a length-preserving
 * `timingSafeEqual` over both byte buffers so that an attacker timing the
 * `401` response cannot recover the secret byte by byte.
 */
function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still run one `timingSafeEqual` against equal-length buffers so the
    // happy-path and mismatched-length paths take similar time.
    const filler = Buffer.alloc(ab.length);
    timingSafeEqual(ab, filler);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function apiKeyAuthPlugin(options: ApiKeyAuthOptions = {}): ServerPlugin {
  const headerName = options.headerName ?? "x-api-key";
  const envKey = options.envKey ?? "MESSAGE_LAYER_API_KEY";
  const protectedPrefixes = options.protectedPrefixes ?? ["/v1/"];
  const strict = options.strict === true;

  let capturedEnv: NodeJS.ProcessEnv | null = null;

  function pathNeedsAuth(pathname: string): boolean {
    return protectedPrefixes.some((prefix) => pathname.startsWith(prefix));
  }

  return {
    name: "api-key-header-auth",
    setup(ctx) {
      capturedEnv = ctx.env;
      ctx.wrapFetch((next) => async (request, ...args) => {
        const path = new URL(request.url).pathname;
        if (!pathNeedsAuth(path)) return next(request, ...args);

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
        if (sent == null || !safeEquals(sent, configuredKey)) {
          return new Response(JSON.stringify({ error: "invalid api key" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return next(request, ...args);
      });
    },

    /**
     * Hono's fetch wrapper only sees HTTP request/response traffic; WebSocket
     * upgrades (`Upgrade: websocket`) are dispatched directly on the raw
     * `http.Server` via its `upgrade` event and therefore bypass any fetch
     * middleware. Without this hook, an API-key-protected server that also
     * enabled the `websocket` plugin would happily accept unauthenticated
     * `ws://.../v1/ws` connections and expose the same stream-subscribe
     * surface that the HTTP API refuses without a key.
     *
     * We register an `upgrade` listener (via `prependListener`, so we run
     * before the websocket plugin's listener) and reject requests that miss
     * or mismatch the key by writing a 401 response and destroying the
     * socket. The websocket plugin's subsequent listener will see a
     * destroyed socket and silently fail to complete the handshake.
     */
    onServerBound(server: HttpServer): void {
      server.prependListener("upgrade", (req: IncomingMessage, socket: Socket) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (!pathNeedsAuth(pathname)) return;

        const env = capturedEnv ?? process.env;
        const configuredKey = env[envKey];
        if (!configuredKey) {
          if (strict) {
            socket.write(
              "HTTP/1.1 503 Service Unavailable\r\n" +
                "Connection: close\r\n" +
                "Content-Length: 0\r\n" +
                "\r\n",
            );
            socket.destroy();
          }
          return;
        }

        const raw = req.headers[headerName.toLowerCase()];
        const sent = Array.isArray(raw) ? raw[0] : raw;
        if (!sent || !safeEquals(sent, configuredKey)) {
          socket.write(
            "HTTP/1.1 401 Unauthorized\r\n" +
              "Connection: close\r\n" +
              "Content-Length: 0\r\n" +
              "\r\n",
          );
          socket.destroy();
        }
      });
    },
  };
}
