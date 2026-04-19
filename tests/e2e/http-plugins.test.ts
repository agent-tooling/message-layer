import { describe, expect, test } from "vitest";
import { createApp } from "../../src/http.js";
import { connect } from "../../src/db.js";
import { MessageLayer } from "../../src/service.js";
import { resolvePlugins, type PluginConfigEntry } from "../../src/plugins.js";

describe("http plugin system", () => {
  test("registers configured plugin routes and middleware", async () => {
    const db = await connect("memory://http-plugin-test", "pglite");
    const svc = new MessageLayer(db);
    const app = createApp(svc);

    const plugins = resolvePlugins([
      { name: "health-meta", options: { version: "test-v1" } },
      { name: "api-key-header-auth", options: { headerName: "x-test-key", apiKey: "secret-1" } },
      "request-logging",
    ] satisfies PluginConfigEntry[]);

    for (const plugin of plugins) {
      plugin.setup?.({ app, service: svc });
      plugin.registerRoutes?.({ app, service: svc });
    }

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    const meta = await app.request("/plugins/health-meta");
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({ plugin: "health-meta", version: "test-v1" });

    const orgWithoutKey = await app.request("/v1/orgs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "UnauthorizedOrg" }),
    });
    expect(orgWithoutKey.status).toBe(401);

    const orgWithKey = await app.request("/v1/orgs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-key": "secret-1" },
      body: JSON.stringify({ name: "AuthorizedOrg" }),
    });
    expect(orgWithKey.status).toBe(200);
  });
});
