import { describe, expect, test } from "vitest";
import { createApp } from "../../src/http.js";
import { connect } from "../../src/db.js";
import { MessageLayer } from "../../src/service.js";
import { applyPluginsToApp, resolvePlugins, type PluginConfigEntry } from "../../src/plugins.js";

describe("http plugin system", () => {
  test("registers configured plugin routes and middleware", async () => {
    const db = await connect("memory://http-plugin-test", "pglite");
    const svc = new MessageLayer(db);
    const app = createApp(svc);

    const plugins = resolvePlugins([
      { name: "health-meta", options: { version: "test-v1" } },
      { name: "api-key-header-auth", options: { headerName: "x-test-key", envKey: "TEST_PLUGIN_API_KEY" } },
      "request-logging",
    ] satisfies PluginConfigEntry[]);

    await applyPluginsToApp(
      {
        app,
        service: svc,
        logger: () => {},
        env: { ...process.env, TEST_PLUGIN_API_KEY: "secret-1" },
        config: { port: 3000, storage: { adapter: "pglite", path: "memory://http-plugin-test" }, plugins: [] },
      },
      plugins,
    );

    const health = await app.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    const meta = await app.fetch(new Request("http://localhost/health/meta"));
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({ ok: true, adapter: "pglite" });

    const orgWithoutKey = await app.fetch(
      new Request("http://localhost/v1/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "UnauthorizedOrg" }),
      }),
    );
    expect(orgWithoutKey.status).toBe(401);

    const orgWithKey = await app.fetch(
      new Request("http://localhost/v1/orgs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-key": "secret-1" },
        body: JSON.stringify({ name: "AuthorizedOrg" }),
      }),
    );
    expect(orgWithKey.status).toBe(200);
  });
});
