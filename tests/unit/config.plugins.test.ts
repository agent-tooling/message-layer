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
    const logger = {
      info: (msg: string) => events.push(msg),
      error: () => {},
    };

    const plugins = instantiatePlugins(
      [
        { name: "request-logging", options: { redactHeaders: ["x-secret"] } },
        { name: "health-meta" },
      ],
      logger,
    );

    for (const plugin of plugins) {
      await plugin.setup?.({ logger, config: { port: 3000, storage: { adapter: "pglite", path: "memory://plugin-unit" }, plugins: [] } });
      plugin.registerRoutes?.(app as Hono, {
        logger,
        config: { port: 3000, storage: { adapter: "pglite", path: "memory://plugin-unit" }, plugins: [] },
      });
    }

    const health = await app.request("http://localhost/health");
    expect(health.status).toBe(200);

    const pluginHealth = await app.request("http://localhost/.well-known/plugin-health");
    expect(pluginHealth.status).toBe(200);
    const body = await pluginHealth.json();
    expect(body).toMatchObject({ ok: true });

    expect(events.some((line) => line.includes("plugin.request-logging"))).toBe(true);
    expect(events.some((line) => line.includes("plugin.health-meta"))).toBe(true);

    await db.close?.();
  });
});
