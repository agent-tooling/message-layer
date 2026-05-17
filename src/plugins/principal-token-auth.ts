import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import type { ServerPlugin } from "../plugins.js";
import { principalSchema, type Principal } from "../types.js";

/**
 * principal-token-auth
 * --------------------
 *
 * Translates a **short-lived HS256 JWT** in a request — issued by the host
 * application (the trusted "identity authority" that owns the human ↔ actor
 * mapping) — into the `x-principal` header that `service.ts` and `ws.ts`
 * already understand.
 *
 * Designed for **browser clients**: they cannot set custom headers when
 * opening a WebSocket, so the token rides as `?token=<jwt>`. The host signs
 * with a secret shared only with this server, so the WS upgrade can prove
 * which actor is connecting without exposing the long-lived
 * `MESSAGE_LAYER_API_KEY`.
 *
 * Coexists with `api-key-header-auth`:
 *   - When the request carries a valid token, this plugin injects both
 *     `x-principal` AND (optionally, via `injectApiKey`) `x-api-key` so the
 *     api-key plugin's downstream check passes.
 *   - When no token is present, this plugin is a no-op and the request
 *     flows through whatever other auth is configured.
 *
 * Token shape (HS256, JSON payload):
 *
 *   {
 *     sub: <actorId>,
 *     oid: <orgId>,
 *     scp: string[],       // scopes; optional, defaults []
 *     pvd: string,         // provider; optional, defaults "principal-token-auth"
 *     iat: number,         // unix seconds
 *     exp: number,         // unix seconds; required
 *     jti: string,         // unique id; required
 *   }
 *
 * Inputs accepted:
 *   - HTTP:  `Authorization: Bearer <jwt>`
 *   - HTTP:  `?token=<jwt>` query
 *   - WS:    `?token=<jwt>` query (browser-friendly)
 *
 * The plugin never reads or writes the database directly — it only
 * rewrites headers for downstream listeners, in line with AGENTS rule #4
 * ("All interactions go through the system").
 */

export type PrincipalTokenAuthOptions = {
  /** Env var holding the HS256 signing secret. Default `MESSAGE_LAYER_TOKEN_SECRET`. */
  envKey?: string;
  /** Query parameter to read the token from. Default `token`. */
  queryName?: string;
  /** When true (the default), validated requests also receive an injected
   * `x-api-key` so a coexisting `api-key-header-auth` plugin lets them
   * through. The value is read from `apiKeyEnvKey` (default
   * `MESSAGE_LAYER_API_KEY`). Pass `false` to disable. */
  injectApiKey?: boolean;
  /** Env var of the API key to inject when `injectApiKey` is true. */
  apiKeyEnvKey?: string;
  /** Header name to set the API key under. Defaults to `x-api-key`. */
  apiKeyHeader?: string;
  /** URL path prefixes the plugin acts on. Defaults to `["/v1/"]`. */
  protectedPrefixes?: string[];
  /** Allow a single token to be replayed within this many seconds. Defaults
   * to no replay tracking — `exp` is the only bound. Pass `0` to disable. */
  replayWindowSeconds?: number;
};

interface DecodedClaims {
  sub: string;
  oid: string;
  scp: string[];
  pvd: string;
  iat: number;
  exp: number;
  jti: string;
}

function base64UrlDecode(input: string): Buffer {
  let s = input.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4 !== 0) s += "=";
  return Buffer.from(s, "base64");
}

function safeEqualsBuffer(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    const filler = Buffer.alloc(a.length);
    try {
      timingSafeEqual(a, filler);
    } catch {
      // alloc length mismatch — defensive
    }
    return false;
  }
  return timingSafeEqual(a, b);
}

function verifyJwt(token: string, secret: string): DecodedClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSig] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSig) return null;

  let header: unknown;
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString("utf8"));
  } catch {
    return null;
  }
  if (
    !header ||
    typeof header !== "object" ||
    (header as { alg?: unknown }).alg !== "HS256" ||
    ((header as { typ?: unknown }).typ !== undefined &&
      (header as { typ?: unknown }).typ !== "JWT")
  ) {
    return null;
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest();
  let signature: Buffer;
  try {
    signature = base64UrlDecode(encodedSig);
  } catch {
    return null;
  }
  if (!safeEqualsBuffer(signature, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.sub !== "string" ||
    typeof p.oid !== "string" ||
    typeof p.exp !== "number" ||
    typeof p.iat !== "number" ||
    typeof p.jti !== "string"
  ) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (p.exp <= now) return null;
  if (p.iat > now + 60) return null; // small clock-skew window

  const scopes: string[] = Array.isArray(p.scp)
    ? p.scp.filter((s): s is string => typeof s === "string")
    : [];
  return {
    sub: p.sub,
    oid: p.oid,
    scp: scopes,
    pvd: typeof p.pvd === "string" ? p.pvd : "principal-token-auth",
    iat: p.iat,
    exp: p.exp,
    jti: p.jti,
  };
}

function claimsToPrincipal(claims: DecodedClaims): Principal | null {
  const candidate = {
    actorId: claims.sub,
    orgId: claims.oid,
    scopes: claims.scp,
    provider: claims.pvd,
  };
  const result = principalSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

/**
 * In-memory replay window. Keyed on `jti`, value is the unix-second expiry.
 * Cleaned lazily on every check; the size is bounded by the number of
 * tokens minted per `replayWindowSeconds` interval (we expect tens of
 * tokens per session for a Homebrew Tales deployment, so this is fine).
 *
 * Each plugin instance has its own cache; if the server scales horizontally
 * a token COULD be replayed once per process within its TTL. That's
 * acceptable in v1 (tokens are short-lived and bound to a single actor).
 */
class ReplayWindow {
  private readonly seen = new Map<string, number>();
  constructor(private readonly windowSeconds: number) {}

  /** Returns true if the jti is new (and records it); false if a replay. */
  check(jti: string, exp: number): boolean {
    if (this.windowSeconds <= 0) return true;
    const now = Math.floor(Date.now() / 1000);
    // Lazy GC: walk the map and drop expired entries.
    if (this.seen.size > 0 && this.seen.size % 64 === 0) {
      for (const [k, v] of this.seen) {
        if (v <= now) this.seen.delete(k);
      }
    }
    const existing = this.seen.get(jti);
    if (existing !== undefined && existing > now) return false;
    this.seen.set(jti, exp);
    return true;
  }
}

export function principalTokenAuthPlugin(
  options: PrincipalTokenAuthOptions = {},
): ServerPlugin {
  const envKey = options.envKey ?? "MESSAGE_LAYER_TOKEN_SECRET";
  const queryName = options.queryName ?? "token";
  const apiKeyHeader = options.apiKeyHeader ?? "x-api-key";
  const apiKeyEnvKey = options.apiKeyEnvKey ?? "MESSAGE_LAYER_API_KEY";
  const protectedPrefixes = options.protectedPrefixes ?? ["/v1/"];
  const replayWindowSeconds = options.replayWindowSeconds ?? 0;
  // Default `injectApiKey` to true: the whole point of this plugin is to
  // let browser clients (which can't set headers on WebSocket() upgrades
  // and don't hold the long-lived API key) reach a server that also has
  // `api-key-header-auth` enabled. Opt out with `{ injectApiKey: false }`
  // for a token-only deployment.
  const injectApiKey = options.injectApiKey !== false;

  const replay = new ReplayWindow(replayWindowSeconds);
  let capturedEnv: NodeJS.ProcessEnv | null = null;

  function pathInScope(pathname: string): boolean {
    return protectedPrefixes.some((p) => pathname.startsWith(p));
  }

  function readBearerToken(request: Request): string | null {
    const auth = request.headers.get("authorization");
    if (!auth) return null;
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    return m ? m[1].trim() : null;
  }

  return {
    name: "principal-token-auth",
    setup(ctx) {
      capturedEnv = ctx.env;

      ctx.wrapFetch((next) => async (request, ...args) => {
        if (!(request instanceof Request)) return next(request, ...args);
        const url = new URL(request.url);
        if (!pathInScope(url.pathname)) return next(request, ...args);

        const secret = ctx.env[envKey];
        if (!secret) return next(request, ...args);

        const token =
          readBearerToken(request) ?? url.searchParams.get(queryName);
        if (!token) return next(request, ...args);

        const claims = verifyJwt(token, secret);
        if (!claims) return next(request, ...args);
        if (!replay.check(claims.jti, claims.exp)) {
          return new Response(
            JSON.stringify({ error: "token already used" }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        const principal = claimsToPrincipal(claims);
        if (!principal) return next(request, ...args);

        const rewritten = new Headers(request.headers);
        rewritten.set("x-principal", JSON.stringify(principal));
        if (injectApiKey) {
          const apiKey = ctx.env[apiKeyEnvKey];
          if (apiKey) rewritten.set(apiKeyHeader, apiKey);
        }
        const rebuilt = new Request(request.url, {
          method: request.method,
          headers: rewritten,
          body:
            request.method === "GET" || request.method === "HEAD"
              ? null
              : await request.clone().arrayBuffer(),
          redirect: request.redirect,
          integrity: request.integrity,
        });
        return next(rebuilt, ...args);
      });
    },

    /**
     * Wire into the raw HTTP `upgrade` event so the WebSocket handshake can
     * be authenticated by `?token=<jwt>` from a browser. Because both this
     * plugin AND `api-key-header-auth` use `prependListener`, the relative
     * registration order matters: this plugin must be registered AFTER
     * api-key-header-auth so its listener runs FIRST.
     */
    onServerBound(server: HttpServer): void {
      server.prependListener(
        "upgrade",
        (req: IncomingMessage, _socket: Socket) => {
          const url = new URL(req.url ?? "/", "http://localhost");
          if (!pathInScope(url.pathname)) return;

          const env = capturedEnv ?? process.env;
          const secret = env[envKey];
          if (!secret) return;

          const token = url.searchParams.get(queryName);
          if (!token) return;

          const claims = verifyJwt(token, secret);
          if (!claims) return;
          if (!replay.check(claims.jti, claims.exp)) {
            // Leave it to the next listener to reject; we don't issue 401
            // ourselves here because another listener may yet allow this
            // request via a different mechanism (e.g. correct api-key).
            return;
          }
          const principal = claimsToPrincipal(claims);
          if (!principal) return;

          req.headers["x-principal"] = JSON.stringify(principal);
          if (injectApiKey) {
            const apiKey = env[apiKeyEnvKey];
            if (apiKey) req.headers[apiKeyHeader.toLowerCase()] = apiKey;
          }
        },
      );
    },
  };
}

/**
 * Mint a token for a principal. Useful in tests and in trusted host code.
 * Produces an HS256 JWT compatible with `principalTokenAuthPlugin`.
 *
 * The plugin verifies the same shape; this helper centralises the encoding
 * so callers don't repeat the base64url + HMAC dance.
 */
export function mintPrincipalToken(input: {
  secret: string;
  actorId: string;
  orgId: string;
  scopes?: string[];
  provider?: string;
  ttlSeconds: number;
  jti: string;
  now?: () => Date;
}): string {
  const now = Math.floor((input.now ?? (() => new Date()))().getTime() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: DecodedClaims = {
    sub: input.actorId,
    oid: input.orgId,
    scp: input.scopes ?? [],
    pvd: input.provider ?? "principal-token-auth",
    iat: now,
    exp: now + input.ttlSeconds,
    jti: input.jti,
  };
  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj), "utf8")
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const signature = createHmac("sha256", input.secret)
    .update(signingInput)
    .digest()
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${signingInput}.${signature}`;
}
