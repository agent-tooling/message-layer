import { describe, expect, test } from "vitest";
import { Hono } from "hono";
import { createPgliteDatabase } from "../../src/db.js";
import { createApp } from "../../src/http.js";
import { parseServerConfig } from "../../src/config.js";
import { MessageLayer } from "../../src/service.js";
import { instantiatePlugins } from "../../src/plugins.js";

describe("server config and plugin system", () => {
  test("parses MESSAGE_LAYER_CONFIG JSON", () => {
    const cfg = parseServerConfig({
      MESSAGE_LAYER_CONFIG: JSON.stringify({
        port: 4123,
        storage: { adapter: "sqlite", path: "/tmp/message-layer-plugin.sqlite" },
        plugins: [{ name: "request-logging", options: { redactHeaders: ["authorization"] } }],
      }),
    });

    expect(cfg.port).toBe(4123);
    expect(cfg.storage.adapter).toBe("sqlite");
    expect(cfg.storage.path).toBe("/tmp/message-layer-plugin.sqlite");
    expect(cfg.plugins).toEqual([{ name: "request-logging", options: { redactHeaders: ["authorization"] } }]);
  });

  test("parses PLUGINS env shorthand", () => {
    const cfg = parseServerConfig({
      PLUGINS: "request-logging,health-meta",
      STORAGE_ADAPTER: "pglite",
      PORT: "3900",
    });
    expect(cfg.port).toBe(3900);
    expect(cfg.plugins.map((plugin) => plugin.name)).toEqual(["request-logging", "health-meta"]);
  });

  test("registers plugin routes and middleware on app", async () => {
    const db = await createPgliteDatabase("memory://plugin-unit");
    const service = new MessageLayer(db);
    const app = createApp(service);

    const events: string[] = [];
    const logger = (msg: string) => {
      events.push(msg);
    };

    const plugins = instantiatePlugins(
      [
        { name: "request-logging", options: { redactHeaders: ["x-secret"] } },
        { name: "health-meta" },
      ],
    );

    const pluginCtx = {
      app: app as Hono,
      service,
      logger,
      env: process.env,
      config: { port: 3000, storage: { adapter: "pglite", path: "memory://plugin-unit" }, plugins: [] },
    };
    const { applyPluginsToApp } = await import("../../src/plugins.js");
    await applyPluginsToApp(pluginCtx, plugins);

    const health = await app.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);

    const pluginHealth = await app.fetch(new Request("http://localhost/health/meta"));
    expect(pluginHealth.status).toBe(200);
    const body = await pluginHealth.json();
    expect(body).toMatchObject({ ok: true, adapter: "pglite" });

    expect(events.some((line) => line.includes("GET /health"))).toBe(true);

    await db.close?.();
  });
});
