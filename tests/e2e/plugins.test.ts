import { afterEach, beforeEach, describe, expect, test } from "vitest";
// Some tests manage their own db lifecycle without using `harness`.
// The outer `harness` is reset in beforeEach so the afterEach hook never
// re-closes a database created in a previous test.
import { connect, type SqlDatabase } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { createApp } from "../../src/http.js";
import { applyPluginSchemas, applyPluginsToApp, resolvePlugins } from "../../src/plugins.js";
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
  await applyPluginSchemas(db, instantiated);
  const dispose = await applyPluginsToApp(
    {
      app,
      db,
      service,
      bus,
      logger: () => {},
      env,
      config: { port: 0, storage: { adapter: "pglite", path: "memory://plug" }, plugins },
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
  }, 10000);

  test("request-logging plugin logs every request via the provided logger", async () => {
    const db = await connect(`memory://req-${Math.random().toString(16).slice(2)}`);
    const bus = new InProcessEventBus();
    const service = new MessageLayer(db, { bus });
    const app = createApp(service);
    const logs: string[] = [];
    const dispose = await applyPluginsToApp(
      {
        app,
        db,
        service,
        bus,
        env: {},
        logger: (m) => logs.push(m),
        config: { port: 0, storage: { adapter: "pglite", path: "x" }, plugins: [] },
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
        db,
        service,
        bus,
        env: {},
        logger: (m) => logs.push(m),
        config: { port: 0, storage: { adapter: "pglite", path: "x" }, plugins: [] },
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

  test("webhooks plugin stores subscriptions and delivers matching events", async () => {
    harness = await makeHarness(["webhooks"]);
    const orgId = await harness.service.createOrg("hooks");
    const adminId = await harness.service.createActor(orgId, "human", "admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "message:append", "webhook:subscribe", "webhook:read"],
      provider: "test",
    };
    const channelId = await harness.service.createChannel(admin, "general", "public");

    const originalFetch = globalThis.fetch;
    const deliveries: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      deliveries.push({
        url: typeof input === "string" ? input : input.url,
        body,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      const create = await harness.app.fetch(
        new Request("http://localhost/v1/webhooks/subscriptions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-principal": JSON.stringify(admin),
          },
          body: JSON.stringify({
            endpoint: "https://example.com/hooks/messages",
            eventTypes: ["message.appended"],
            streamId: channelId,
          }),
        }),
      );
      expect(create.status).toBe(200);
      await harness.service.appendMessage(admin, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "hello hook" } }],
        idempotencyKey: "hook-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deliveries.length).toBeGreaterThan(0);
      expect(deliveries[0]?.url).toBe("https://example.com/hooks/messages");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("webhooks plugin enforces webhook:subscribe capability", async () => {
    harness = await makeHarness(["webhooks"]);
    const orgId = await harness.service.createOrg("hooks-auth");
    const actorId = await harness.service.createActor(orgId, "human", "member");
    const principal: Principal = { actorId, orgId, scopes: [], provider: "test" };
    const response = await harness.app.fetch(
      new Request("http://localhost/v1/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-principal": JSON.stringify(principal),
        },
        body: JSON.stringify({
          endpoint: "https://example.com/hooks/messages",
          eventTypes: ["message.appended"],
        }),
      }),
    );
    expect(response.status).toBe(403);
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
      config: { ...defaultServerConfig({}), plugins: ["health-meta"], port: 0 },
    });
    const res = await fetch(`${server.address}/health/meta`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: string[] };
    expect(body.plugins).toContain("health-meta");
  });
});
