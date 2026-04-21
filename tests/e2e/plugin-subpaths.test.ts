/**
 * Tests for all plugin and storage subpath exports.
 *
 * Each plugin is imported from its own subpath (the way a real consumer would
 * use it) and exercised against a real startServer() instance on a random port.
 * The storage factories are also tested in isolation.
 *
 * This test suite does NOT duplicate the detailed behavioural tests in
 * plugins.test.ts — it focuses on:
 *   1. Typed subpath imports work (imports resolve and produce correct objects)
 *   2. Each plugin's factory produces a valid ServerPlugin with the right name
 *   3. Each plugin works end-to-end when passed to startServer via subpath import
 *   4. Storage factories return the correct descriptors and createXxx functions work
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";

// ── Plugin subpath imports ─────────────────────────────────────────────────
import { apiKeyAuthPlugin } from "../../src/plugins/api-key-auth.js";
import { durableStreamsPlugin } from "../../src/plugins/durable-streams.js";
import { eventLoggerPlugin } from "../../src/plugins/event-logger.js";
import { healthMetaPlugin } from "../../src/plugins/health-meta.js";
import { inMemoryKnowledgePlugin } from "../../src/plugins/in-memory-knowledge.js";
import { requestLoggingPlugin } from "../../src/plugins/request-logging.js";
import { scopedKnowledgePlugin } from "../../src/plugins/scoped-knowledge.js";
import { webhookPlugin } from "../../src/plugins/webhooks.js";
import { websocketPlugin } from "../../src/plugins/websocket.js";

// ── Storage subpath imports ────────────────────────────────────────────────
import { createPgliteDatabase, pglite } from "../../src/storage/pglite.js";
import { postgres } from "../../src/storage/postgres.js";

// ── Server infrastructure ─────────────────────────────────────────────────
import { startServer, type RunningServer } from "../../src/server-runtime.js";
import { defaultServerConfig } from "../../src/config.js";
import { MessageLayer } from "../../src/service.js";

// ─────────────────────────────────────────────────────────────────────────────

describe("plugin factory names", () => {
  test("all subpath-imported factories produce plugins with correct names", () => {
    expect(apiKeyAuthPlugin().name).toBe("api-key-header-auth");
    expect(durableStreamsPlugin().name).toBe("durable-streams");
    expect(eventLoggerPlugin().name).toBe("event-logger");
    expect(healthMetaPlugin().name).toBe("health-meta");
    expect(inMemoryKnowledgePlugin().name).toBe("in-memory-knowledge");
    expect(requestLoggingPlugin().name).toBe("request-logging");
    expect(scopedKnowledgePlugin().name).toBe("scoped-knowledge");
    expect(webhookPlugin().name).toBe("webhooks");
    expect(websocketPlugin().name).toBe("websocket");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("storage factories", () => {
  test("pglite() returns correct storage descriptor", () => {
    expect(pglite()).toEqual({ adapter: "pglite", path: "memory://default" });
    expect(pglite("./.data/test")).toEqual({ adapter: "pglite", path: "./.data/test" });
    expect(pglite("memory://mydb")).toEqual({ adapter: "pglite", path: "memory://mydb" });
  });

  test("postgres() returns correct storage descriptor", () => {
    const url = "postgresql://user:pass@localhost:5432/db";
    expect(postgres(url)).toEqual({ adapter: "postgres", path: url });
  });

  test("postgres() throws on empty connection string", () => {
    expect(() => postgres("")).toThrow("connectionString must be non-empty");
    expect(() => postgres("   ")).toThrow("connectionString must be non-empty");
  });

  test("createPgliteDatabase() from subpath creates a working database", async () => {
    const db = await createPgliteDatabase("memory://subpath-test");
    const result = await db.query("SELECT 1 AS n");
    expect(result.rows[0]).toMatchObject({ n: 1 });
    await db.close?.();
  });

  test("pglite descriptor can be passed to MessageLayer via createPgliteDatabase", async () => {
    const descriptor = pglite("memory://factory-test");
    const db = await createPgliteDatabase(descriptor.path);
    const service = new MessageLayer(db);
    const orgId = await service.createOrg("Factory Test Org");
    expect(orgId).toMatch(/^[0-9a-f]{32}$/);
    await db.close?.();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("plugin subpaths via startServer()", () => {
  let server: RunningServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  test("requestLoggingPlugin() imported from subpath logs requests", async () => {
    const logs: string[] = [];
    server = await startServer({
      port: 0,
      logger: (m) => logs.push(m),
      config: {
        ...defaultServerConfig({}),
        plugins: [requestLoggingPlugin({ prefix: "[subpath-test]" })],
        port: 0,
        websocket: false,
      },
    });
    await fetch(`${server.address}/health`);
    expect(logs.some((l) => l.includes("[subpath-test]") && l.includes("GET /health"))).toBe(true);
  });

  test("healthMetaPlugin() imported from subpath serves /health/meta", async () => {
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: [healthMetaPlugin({ version: "subpath-1.0" })],
        port: 0,
        websocket: false,
      },
    });
    const res = await fetch(`${server.address}/health/meta`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.version).toBe("subpath-1.0");
  });

  test("apiKeyAuthPlugin() imported from subpath enforces the secret", async () => {
    const secret = "subpath-secret-xyz";
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: [apiKeyAuthPlugin({ envKey: "SUBPATH_KEY", strict: true })],
        port: 0,
        websocket: false,
      },
      env: { SUBPATH_KEY: secret },
    });

    // No key → 401
    const noKey = await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(noKey.status).toBe(401);

    // Correct key → 200
    const withKey = await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": secret },
      body: JSON.stringify({ name: "X" }),
    });
    expect(withKey.status).toBe(200);
  });

  test("apiKeyAuthPlugin() strict mode returns 503 when env var unset", async () => {
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: [apiKeyAuthPlugin({ envKey: "DEFINITELY_MISSING_KEY_123", strict: true })],
        port: 0,
        websocket: false,
      },
      env: {},
    });
    const res = await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(res.status).toBe(503);
  });

  test("eventLoggerPlugin() imported from subpath captures domain events", async () => {
    const logs: string[] = [];
    server = await startServer({
      port: 0,
      logger: (m) => logs.push(m),
      config: {
        ...defaultServerConfig({}),
        plugins: [eventLoggerPlugin({ prefix: "[evt-subpath]" })],
        port: 0,
        websocket: false,
      },
    });
    await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "EventOrg" }),
    });
    expect(logs.some((l) => l.includes("[evt-subpath]") && l.includes("org.created"))).toBe(true);
  });

  test("websocketPlugin() replaces config websocket flag: server accepts WS connections", async () => {
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: [websocketPlugin()],
        port: 0,
        websocket: false, // flag is off — plugin handles it
      },
    });

    // Bootstrap org + actor
    const orgRes = await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "WsPluginOrg" }),
    });
    const { orgId } = (await orgRes.json()) as { orgId: string };
    const actorRes = await fetch(`${server.address}/v1/actors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId, actorType: "human", displayName: "Alice" }),
    });
    const { actorId } = (await actorRes.json()) as { actorId: string };
    const principal = { actorId, orgId, scopes: ["channel:create"], provider: "test" };

    const wsUrl = server.address.replace(/^http/, "ws");
    const ws = new NodeWebSocket(`${wsUrl}/v1/ws`, {
      headers: { "x-principal": JSON.stringify(principal) },
    });

    const welcome = await new Promise<{ type: string; actorId: string }>((resolve, reject) => {
      ws.once("open", () => {}); // connection opened
      ws.once("message", (raw) => {
        resolve(JSON.parse(raw.toString()) as { type: string; actorId: string });
      });
      ws.once("error", reject);
      setTimeout(() => reject(new Error("ws welcome timeout")), 3000);
    });

    expect(welcome.type).toBe("welcome");
    expect(welcome.actorId).toBe(actorId);
    ws.close();
  });

  test("websocketPlugin() is disposed cleanly on server.close()", async () => {
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: [websocketPlugin()],
        port: 0,
        websocket: false,
      },
    });
    // Should not throw
    await expect(server.close()).resolves.toBeUndefined();
    server = undefined; // already closed
  });

  test("all plugins can be combined in a single server with no conflicts", async () => {
    const logs: string[] = [];
    server = await startServer({
      port: 0,
      logger: (m) => logs.push(m),
      config: {
        ...defaultServerConfig({}),
        plugins: [
          requestLoggingPlugin({ prefix: "[combo]" }),
          healthMetaPlugin({ version: "combo-test" }),
          eventLoggerPlugin({ prefix: "[combo-evt]" }),
          inMemoryKnowledgePlugin(),
          webhookPlugin(),
          websocketPlugin(),
        ],
        port: 0,
        websocket: false,
      },
    });

    // Health meta works
    const meta = await fetch(`${server.address}/health/meta`);
    expect(meta.status).toBe(200);

    // Request logging fired
    expect(logs.some((l) => l.includes("[combo]") && l.includes("/health/meta"))).toBe(true);

    // Event logger fires on org creation
    await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ComboOrg" }),
    });
    expect(logs.some((l) => l.includes("[combo-evt]") && l.includes("org.created"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("string-based plugin names still work (backward compat)", () => {
  let server: RunningServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  test("'websocket' string name bootstraps the websocket plugin", async () => {
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: ["websocket"],
        port: 0,
        websocket: false,
      },
    });

    const orgRes = await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "BcOrg" }),
    });
    const { orgId } = (await orgRes.json()) as { orgId: string };
    const actorRes = await fetch(`${server.address}/v1/actors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId, actorType: "human", displayName: "Bob" }),
    });
    const { actorId } = (await actorRes.json()) as { actorId: string };
    const principal = { actorId, orgId, scopes: [], provider: "test" };

    const wsUrl = server.address.replace(/^http/, "ws");
    const ws = new NodeWebSocket(`${wsUrl}/v1/ws`, {
      headers: { "x-principal": JSON.stringify(principal) },
    });
    const welcome = await new Promise<{ type: string }>((resolve, reject) => {
      ws.once("message", (raw) => resolve(JSON.parse(raw.toString()) as { type: string }));
      ws.once("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 3000);
    });
    expect(welcome.type).toBe("welcome");
    ws.close();
  });

  test("'api-key-header-auth' string name still enforces the key", async () => {
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: [{ name: "api-key-header-auth", options: { envKey: "BC_API_KEY" } }],
        port: 0,
        websocket: false,
      },
      env: { BC_API_KEY: "bc-secret" },
    });
    const res = await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(res.status).toBe(401);
  });
});
