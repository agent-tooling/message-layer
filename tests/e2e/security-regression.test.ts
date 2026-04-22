import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { connect, type SqlDatabase } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { createApp } from "../../src/http.js";
import { MessageLayer } from "../../src/service.js";
import { InMemoryStorageAdapter } from "../../src/storage.js";
import { apiKeyAuthPlugin } from "../../src/plugins/api-key-auth.js";
import { websocketPlugin } from "../../src/plugins/websocket.js";
import { applyPluginsToApp, resolvePlugins } from "../../src/plugins.js";
import { startServer, type RunningServer } from "../../src/server-runtime.js";
import { defaultServerConfig } from "../../src/config.js";
import type { Principal } from "../../src/types.js";
import { HttpClient, appFetcher } from "../helpers/http-client.js";

/**
 * Regression tests for security-sensitive behaviour in the headless server.
 *
 * Each test documents the issue it locks down so reviewers understand what
 * will break if the guard is removed.
 */

// ── Issue 1: `api-key-header-auth` must compare keys in constant time ─────
// A naïve `sent !== configuredKey` comparison leaks the expected key byte by
// byte to an attacker that can time the `401` response. Switching to
// `crypto.timingSafeEqual` also has to keep the functional behaviour intact:
// correct keys pass, wrong keys (same-length, different-length, missing)
// all reject with 401.
describe("api-key-auth comparison", () => {
  let server: RunningServer;
  const SECRET = "correct-horse-battery-staple";

  beforeEach(async () => {
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: [
          { name: "api-key-header-auth", options: { envKey: "ML_SEC_KEY", strict: true } },
        ],
        port: 0,
      },
      env: { ML_SEC_KEY: SECRET },
    });
  });

  afterEach(async () => {
    await server?.close();
  });

  test("accepts the correct key", async () => {
    const res = await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": SECRET },
      body: JSON.stringify({ name: "Acme" }),
    });
    expect(res.status).toBe(200);
  });

  test("rejects a same-length wrong key with 401", async () => {
    const wrong = "x".repeat(SECRET.length);
    const res = await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": wrong },
      body: JSON.stringify({ name: "Acme" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects a different-length wrong key with 401", async () => {
    const res = await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "too-short" },
      body: JSON.stringify({ name: "Acme" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects a missing key with 401", async () => {
    const res = await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    });
    expect(res.status).toBe(401);
  });
});

// ── Issue 2: WebSocket upgrade must be covered by api-key-auth ────────────
// Hono's fetch wrapper cannot see `Upgrade: websocket` requests because they
// are dispatched directly on `http.Server#on("upgrade", …)`. Before the fix,
// a server that had both `api-key-header-auth` and `websocket` enabled would
// happily accept unauthenticated `/v1/ws` connections and expose stream
// subscriptions without the key. The plugin now also hooks the `upgrade`
// event to reject missing / wrong keys at the transport layer.
describe("api-key-auth covers WebSocket upgrades", () => {
  let server: RunningServer;
  const SECRET = "ws-secret-abcdef0123";

  beforeEach(async () => {
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: [
          { name: "api-key-header-auth", options: { envKey: "ML_WS_KEY", strict: true } },
          websocketPlugin(),
        ],
        port: 0,
      },
      env: { ML_WS_KEY: SECRET },
    });
  });

  afterEach(async () => {
    await server?.close();
  });

  async function bootstrapAdmin(): Promise<{ admin: Principal; channelId: string }> {
    const orgId = await server.service.createOrg("Acme");
    const adminId = await server.service.createActor(orgId, "human", "admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["grant:create", "channel:create", "message:append"],
      provider: "test",
    };
    const channelId = await server.service.createChannel(admin, "general", "public");
    return { admin, channelId };
  }

  test("rejects WebSocket upgrade without api key", async () => {
    const { admin } = await bootstrapAdmin();
    const wsUrl = `${server.address.replace(/^http/, "ws")}/v1/ws`;
    const ws = new NodeWebSocket(wsUrl, {
      headers: { "x-principal": JSON.stringify(admin) },
    });

    const result = await new Promise<{ type: "open" } | { type: "error"; code: number | null; message: string }>(
      (resolve) => {
        ws.once("open", () => resolve({ type: "open" }));
        ws.once("unexpected-response", (_req, res) => {
          resolve({ type: "error", code: res.statusCode ?? null, message: res.statusMessage ?? "" });
          ws.terminate();
        });
        ws.once("error", (err: Error) => {
          resolve({ type: "error", code: null, message: err.message });
        });
      },
    );

    expect(result.type).toBe("error");
    if (result.type === "error") {
      // Accept either the clean 401 unexpected-response path or a socket hang-up
      // (depending on how the underlying ws client surfaces the rejection).
      expect(result.code === 401 || /unexpected|socket|reset|ECONNRESET|hang up/i.test(result.message)).toBe(true);
    }
  });

  test("rejects WebSocket upgrade with wrong api key", async () => {
    const { admin } = await bootstrapAdmin();
    const wsUrl = `${server.address.replace(/^http/, "ws")}/v1/ws`;
    const ws = new NodeWebSocket(wsUrl, {
      headers: { "x-principal": JSON.stringify(admin), "x-api-key": "nope" },
    });

    const result = await new Promise<{ type: "open" } | { type: "error"; code: number | null }>((resolve) => {
      ws.once("open", () => resolve({ type: "open" }));
      ws.once("unexpected-response", (_req, res) => {
        resolve({ type: "error", code: res.statusCode ?? null });
        ws.terminate();
      });
      ws.once("error", () => resolve({ type: "error", code: null }));
    });

    expect(result.type).toBe("error");
  });

  test("accepts WebSocket upgrade with correct api key", async () => {
    const { admin } = await bootstrapAdmin();
    const wsUrl = `${server.address.replace(/^http/, "ws")}/v1/ws`;
    const ws = new NodeWebSocket(wsUrl, {
      headers: { "x-principal": JSON.stringify(admin), "x-api-key": SECRET },
    });

    const opened = await new Promise<boolean>((resolve) => {
      ws.once("open", () => resolve(true));
      ws.once("unexpected-response", () => resolve(false));
      ws.once("error", () => resolve(false));
    });
    expect(opened).toBe(true);
    ws.close();
  });
});

// ── Issue 3: artifact download must set `x-content-type-options: nosniff` ─
// Artifact bytes and their declared content-type both come from a client.
// Without `nosniff`, browsers may sniff an uploaded `text/plain` blob into
// an executable type (HTML / SVG-with-script) when it is fetched through
// the message-layer origin. Paired with the existing `attachment`
// disposition this closes the stored-XSS vector for any deployment that
// proxies artifact downloads from the same origin as the UI.
describe("artifact download sets nosniff", () => {
  type Harness = {
    db: SqlDatabase;
    service: MessageLayer;
    http: HttpClient;
    app: ReturnType<typeof createApp>;
    close: () => Promise<void>;
  };
  let harness: Harness;

  beforeEach(async () => {
    const db = await connect(`memory://sec-art-${Math.random().toString(16).slice(2)}`);
    const bus = new InProcessEventBus();
    const service = new MessageLayer(db, { bus, storage: new InMemoryStorageAdapter() });
    const app = createApp(service);
    const http = new HttpClient("http://localhost", appFetcher(app));
    harness = {
      db,
      service,
      app,
      http,
      close: async () => {
        await db.close?.();
      },
    };
  });
  afterEach(async () => {
    await harness.close();
  });

  test("/v1/artifacts/:id/content includes X-Content-Type-Options: nosniff", async () => {
    const org = await harness.http.post<{ orgId: string }>("/v1/orgs", { name: "Acme" }, null);
    const actor = await harness.http.post<{ actorId: string }>(
      "/v1/actors",
      { orgId: org.body.orgId, actorType: "human", displayName: "admin" },
      null,
    );
    const admin: Principal = {
      actorId: actor.body.actorId,
      orgId: org.body.orgId,
      scopes: ["grant:create", "channel:create", "message:append", "channel:admin"],
      provider: "test",
    };
    const ch = await harness.http.post<{ channelId: string }>(
      "/v1/channels",
      { name: "general", visibility: "public" },
      admin,
    );
    const upload = await harness.http.post<{ artifact: { id: string } }>(
      "/v1/artifacts",
      {
        streamId: ch.body.channelId,
        streamType: "channel",
        filename: "evil.html",
        // Attacker-chosen content-type: nosniff prevents the browser from
        // "helpfully" rendering the body as HTML when it should download.
        contentType: "text/plain",
        contentBase64: Buffer.from("<script>alert(1)</script>").toString("base64"),
      },
      admin,
    );
    expect(upload.status).toBe(200);

    const res = await harness.app.fetch(
      new Request(`http://localhost/v1/artifacts/${upload.body.artifact.id}/content`, {
        headers: { "x-principal": JSON.stringify(admin) },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // Disposition is still `attachment` so browsers never render inline.
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  });
});

// Keep linter happy: `apiKeyAuthPlugin`, `applyPluginsToApp`, `resolvePlugins`
// are imported to give this file first-class visibility into the auth plugin
// surface even though we go through the registry via `startServer` above.
void apiKeyAuthPlugin;
void applyPluginsToApp;
void resolvePlugins;
