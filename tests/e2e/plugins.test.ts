import { afterEach, beforeEach, describe, expect, test } from "vitest";
// Some tests manage their own db lifecycle without using `harness`.
// The outer `harness` is reset in beforeEach so the afterEach hook never
// re-closes a database created in a previous test.
import { connect, type SqlDatabase } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { createApp } from "../../src/http.js";
import { applyPluginsToApp, resolvePlugins } from "../../src/plugins.js";
import type { PluginConfigEntry } from "../../src/config.js";
import { MessageLayer } from "../../src/service.js";
import { startServer, type RunningServer } from "../../src/server-runtime.js";
import { defaultServerConfig } from "../../src/config.js";
import type { Principal } from "../../src/types.js";

type PluginHarness = {
  db: SqlDatabase;
  service: MessageLayer;
  bus: InProcessEventBus;
  app: ReturnType<typeof createApp>;
  env: NodeJS.ProcessEnv;
  dispose: () => Promise<void>;
  close: () => Promise<void>;
};

async function makeHarness(plugins: PluginConfigEntry[], env: NodeJS.ProcessEnv = {}): Promise<PluginHarness> {
  const db = await connect(`memory://plug-${Math.random().toString(16).slice(2)}`);
  const bus = new InProcessEventBus();
  const service = new MessageLayer(db, { bus });
  const app = createApp(service);
  const instantiated = resolvePlugins(plugins);
  const dispose = await applyPluginsToApp(
    {
      app,
      service,
      bus,
      logger: () => {},
      env,
      config: { port: 0, storage: { adapter: "pglite", path: "memory://plug" }, plugins, websocket: false },
    },
    instantiated,
  );
  return {
    db,
    service,
    bus,
    app,
    env,
    dispose,
    close: async () => {
      await dispose();
      await db.close?.();
    },
  };
}

describe("built-in plugins", () => {
  let harness: PluginHarness | undefined;
  beforeEach(() => {
    harness = undefined;
  });
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  test("health-meta plugin exposes /health/meta with adapter + plugin list", async () => {
    harness = await makeHarness([{ name: "health-meta", options: { version: "test-1" } }]);
    const res = await harness.app.fetch(new Request("http://localhost/health/meta"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, adapter: "pglite", version: "test-1", plugins: ["health-meta"] });
  });

  test("request-logging plugin logs every request via the provided logger", async () => {
    const db = await connect(`memory://req-${Math.random().toString(16).slice(2)}`);
    const bus = new InProcessEventBus();
    const service = new MessageLayer(db, { bus });
    const app = createApp(service);
    const logs: string[] = [];
    const dispose = await applyPluginsToApp(
      {
        app,
        service,
        bus,
        env: {},
        logger: (m) => logs.push(m),
        config: { port: 0, storage: { adapter: "pglite", path: "x" }, plugins: [], websocket: false },
      },
      resolvePlugins([{ name: "request-logging", options: { prefix: "TST" } }]),
    );
    await app.fetch(new Request("http://localhost/health"));
    await dispose();
    await db.close?.();
    expect(logs.find((l) => l.includes("TST") && l.includes("GET /health"))).toBeTruthy();
  });

  test("api-key-header-auth plugin enforces key when env var is set", async () => {
    harness = await makeHarness(
      [{ name: "api-key-header-auth", options: { headerName: "x-test-key", envKey: "TEST_API_KEY" } }],
      { TEST_API_KEY: "s3cret" },
    );
    const noKey = await harness.app.fetch(
      new Request("http://localhost/v1/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Z" }),
      }),
    );
    expect(noKey.status).toBe(401);
    const withKey = await harness.app.fetch(
      new Request("http://localhost/v1/orgs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-key": "s3cret" },
        body: JSON.stringify({ name: "Z" }),
      }),
    );
    expect(withKey.status).toBe(200);
  });

  test("api-key-header-auth plugin in strict mode rejects when key not configured", async () => {
    harness = await makeHarness([
      { name: "api-key-header-auth", options: { envKey: "MISSING_KEY", strict: true } },
    ]);
    const res = await harness.app.fetch(
      new Request("http://localhost/v1/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      }),
    );
    expect(res.status).toBe(503);
  });

  test("event-logger plugin receives every domain event emitted by core", async () => {
    const db = await connect(`memory://evlog-${Math.random().toString(16).slice(2)}`);
    const bus = new InProcessEventBus();
    const service = new MessageLayer(db, { bus });
    const app = createApp(service);
    const logs: string[] = [];
    const dispose = await applyPluginsToApp(
      {
        app,
        service,
        bus,
        env: {},
        logger: (m) => logs.push(m),
        config: { port: 0, storage: { adapter: "pglite", path: "x" }, plugins: [], websocket: false },
      },
      resolvePlugins(["event-logger"]),
    );
    const orgId = await service.createOrg("Plug");
    await service.createActor(orgId, "human", "u");
    await dispose();
    await db.close?.();
    expect(logs.some((l) => l.includes("org.created"))).toBe(true);
    expect(logs.some((l) => l.includes("membership.updated"))).toBe(true);
  });

  test("in-memory-knowledge plugin builds a per-stream index from events and exposes a route", async () => {
    harness = await makeHarness(["in-memory-knowledge"]);
    const orgId = await harness.service.createOrg("KB");
    const adminId = await harness.service.createActor(orgId, "human", "admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "message:append"],
      provider: "test",
    };
    const channelId = await harness.service.createChannel(admin, "general", "public");
    const append = await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "indexed" } }],
      idempotencyKey: "a",
    });
    if ("denied" in append && append.denied) throw new Error("unexpected denial");
    const res = await harness.app.fetch(new Request(`http://localhost/plugins/knowledge/${channelId}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { streamId: string; messageIds: string[] };
    expect(body.messageIds).toContain(append.messageId);
  });

  test("unknown plugin name throws during resolution", () => {
    expect(() => resolvePlugins(["nope"])).toThrow(/unknown plugin/);
  });
});

describe("plugins via real running server", () => {
  let server: RunningServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  test("health-meta plugin is reachable on the network port", async () => {
    server = await startServer({
      port: 0,
      logger: () => {},
      config: { ...defaultServerConfig({}), plugins: ["health-meta"], port: 0, websocket: false },
    });
    const res = await fetch(`${server.address}/health/meta`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: string[] };
    expect(body.plugins).toContain("health-meta");
  });
});
