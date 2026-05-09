import { createHmac } from "node:crypto";
import { createServer } from "node:http";
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
      config: { port: 0, storage: { adapter: "pglite", path: "memory://plug" }, artifacts: { kind: "memory" }, plugins },
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
        config: { port: 0, storage: { adapter: "pglite", path: "x" }, artifacts: { kind: "memory" }, plugins: [] },
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
        config: { port: 0, storage: { adapter: "pglite", path: "x" }, artifacts: { kind: "memory" }, plugins: [] },
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
    harness = await makeHarness([
      {
        name: "webhooks",
        options: { allowPrivateNetworks: true },
      },
    ]);
    const orgId = await harness.service.createOrg("hooks");
    const adminId = await harness.service.createActor(orgId, "human", "admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "message:append", "webhook:subscribe", "webhook:read"],
      provider: "test",
    };
    const channelId = await harness.service.createChannel(admin, "general", "public");

    const deliveries: Array<{ url: string; body: unknown }> = [];
    const sink = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      deliveries.push({
        url: `http://127.0.0.1:${(sink.address() as { port: number }).port}${req.url ?? ""}`,
        body: raw ? JSON.parse(raw) : {},
      });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", () => resolve()));
    const sinkAddress = sink.address();
    if (!sinkAddress || typeof sinkAddress === "string") throw new Error("failed to start sink");

    try {
      const create = await harness.app.fetch(
        new Request("http://localhost/v1/webhooks/subscriptions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-principal": JSON.stringify(admin),
          },
          body: JSON.stringify({
            endpoint: `http://127.0.0.1:${sinkAddress.port}/hooks/messages`,
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
      // One microtask was enough when the delivery path was a single
      // `fetch` call; delivery remains async relative to appendMessage.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(deliveries.length).toBeGreaterThan(0);
      expect(deliveries[0]?.url).toContain("/hooks/messages");
    } finally {
      await new Promise<void>((resolve, reject) => sink.close((err) => (err ? reject(err) : resolve())));
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

  test("telegram bridge binds inbound chat and relays outbound agent messages", async () => {
    const token = "telegram-test-token";
    const signingKey = "telegram-secret-key";
    const telegramCalls: {
      setWebhook: Array<Record<string, unknown>>;
      deleteWebhook: Array<Record<string, unknown>>;
      sendMessage: Array<Record<string, unknown>>;
    } = {
      setWebhook: [],
      deleteWebhook: [],
      sendMessage: [],
    };
    const telegramApi = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const match = req.url?.match(/^\/bot([^/]+)\/([^/?]+)/);
      if (!match) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, description: "not found" }));
        return;
      }
      const [, requestToken, method] = match;
      if (requestToken !== token) {
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false, description: "bad token" }));
        return;
      }
      if (method === "getMe") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result: { id: 123456, username: "msg_layer_test_bot" } }));
        return;
      }
      if (method === "setWebhook") {
        telegramCalls.setWebhook.push(body);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      if (method === "deleteWebhook") {
        telegramCalls.deleteWebhook.push(body);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      if (method === "sendMessage") {
        telegramCalls.sendMessage.push(body);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result: { message_id: 998877 } }));
        return;
      }
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, description: "unknown method" }));
    });
    await new Promise<void>((resolve) => telegramApi.listen(0, "127.0.0.1", () => resolve()));
    const address = telegramApi.address();
    if (!address || typeof address === "string") throw new Error("failed to start telegram api stub");
    try {
      harness = await makeHarness([
        {
          name: "telegram-bridge",
          options: {
            publicBaseUrl: "https://ml.example.com",
            webhookSecretSigningKey: signingKey,
            telegramApiBaseUrl: `http://127.0.0.1:${address.port}`,
          },
        },
      ]);
      const orgId = await harness.service.createOrg("telegram-bridge");
      const adminId = await harness.service.createActor(orgId, "human", "admin");
      const humanId = await harness.service.createActor(orgId, "human", "andre");
      const agentId = await harness.service.createActor(orgId, "agent", "helper-agent");
      const admin: Principal = {
        actorId: adminId,
        orgId,
        scopes: ["channel:create", "grant:create", "bridge:telegram:manage"],
        provider: "test",
      };
      const agent: Principal = {
        actorId: agentId,
        orgId,
        scopes: ["message:append"],
        provider: "test",
      };
      const channelId = await harness.service.createChannel(admin, "general", "public");
      await harness.service.createGrant(admin, humanId, "channel", channelId, "message:append");

      const setupRes = await harness.app.fetch(
        new Request("http://localhost/v1/bridges/telegram/setups", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-principal": JSON.stringify(admin),
          },
          body: JSON.stringify({
            humanActorId: humanId,
            channelId,
            botToken: token,
          }),
        }),
      );
      expect(setupRes.status).toBe(200);
      const setupJson = (await setupRes.json()) as {
        setupId: string;
        status: string;
        webhookUrl: string;
      };
      expect(setupJson.status).toBe("pending_bind");
      expect(telegramCalls.setWebhook).toHaveLength(1);
      expect(telegramCalls.setWebhook[0]?.url).toBe(setupJson.webhookUrl);

      const saltRow = await harness.db.query<{ webhook_secret_salt: string }>(
        "SELECT webhook_secret_salt FROM telegram_bridge_setups WHERE id=?",
        [setupJson.setupId],
      );
      const salt = saltRow.rows[0]?.webhook_secret_salt;
      if (!salt) throw new Error("missing setup salt");
      const secret = createHmac("sha256", signingKey)
        .update(`telegram:${setupJson.setupId}:${salt}`)
        .digest("hex");

      const badWebhook = await harness.app.fetch(
        new Request(`http://localhost/v1/bridges/telegram/webhook/${setupJson.setupId}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": "bad-secret",
          },
          body: JSON.stringify({
            update_id: 1,
            message: { message_id: 10, chat: { id: 4444, type: "private" }, text: "hello" },
          }),
        }),
      );
      expect(badWebhook.status).toBe(401);

      const inbound = await harness.app.fetch(
        new Request(`http://localhost/v1/bridges/telegram/webhook/${setupJson.setupId}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": secret,
          },
          body: JSON.stringify({
            update_id: 1001,
            message: { message_id: 55, chat: { id: 4444, type: "private" }, text: "hello from telegram" },
          }),
        }),
      );
      expect(inbound.status).toBe(200);
      const duplicate = await harness.app.fetch(
        new Request(`http://localhost/v1/bridges/telegram/webhook/${setupJson.setupId}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": secret,
          },
          body: JSON.stringify({
            update_id: 1001,
            message: { message_id: 55, chat: { id: 4444, type: "private" }, text: "hello from telegram" },
          }),
        }),
      );
      expect(duplicate.status).toBe(200);
      const duplicateJson = (await duplicate.json()) as { duplicate?: boolean };
      expect(duplicateJson.duplicate).toBe(true);

      const messagesAfterInbound = await harness.service.listMessages(admin, channelId, {
        streamType: "channel",
      });
      expect(messagesAfterInbound).toHaveLength(1);
      expect(messagesAfterInbound[0]?.actorId).toBe(humanId);
      expect(messagesAfterInbound[0]?.parts[0]?.payload).toMatchObject({ text: "hello from telegram" });

      await harness.service.appendMessage(agent, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "agent reply" } }],
        idempotencyKey: "agent-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(telegramCalls.sendMessage).toHaveLength(1);
      expect(telegramCalls.sendMessage[0]).toMatchObject({ chat_id: "4444", text: "agent reply" });

      const disable = await harness.app.fetch(
        new Request(`http://localhost/v1/bridges/telegram/setups/${setupJson.setupId}/disable`, {
          method: "POST",
          headers: { "x-principal": JSON.stringify(admin) },
        }),
      );
      expect(disable.status).toBe(200);
      expect(telegramCalls.deleteWebhook).toHaveLength(1);

      await harness.service.appendMessage(agent, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "post-disable reply" } }],
        idempotencyKey: "agent-2",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(telegramCalls.sendMessage).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => telegramApi.close((err) => (err ? reject(err) : resolve())));
    }
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
