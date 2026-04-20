import { describe, expect, test } from "vitest";
import { defaultServerConfig, parseServerConfig } from "../../src/config.js";

describe("config", () => {
  test("defaults to pglite at port 3000 with websocket enabled", () => {
    const cfg = defaultServerConfig({});
    expect(cfg).toMatchObject({
      port: 3000,
      storage: { adapter: "pglite", path: "memory://server" },
      plugins: [],
      websocket: true,
    });
  });

  test("parses PLUGINS env shorthand into objects", () => {
    const cfg = parseServerConfig({ PLUGINS: "request-logging,health-meta" });
    expect(cfg.plugins).toEqual([{ name: "request-logging" }, { name: "health-meta" }]);
  });

  test("parses MESSAGE_LAYER_CONFIG JSON and merges with env defaults", () => {
    const cfg = parseServerConfig({
      MESSAGE_LAYER_CONFIG: JSON.stringify({
        port: 4123,
        storage: { adapter: "pglite", path: "memory://explicit" },
        plugins: [{ name: "request-logging", options: { prefix: "X" } }],
      }),
    });
    expect(cfg.port).toBe(4123);
    expect(cfg.storage.path).toBe("memory://explicit");
    expect(cfg.plugins).toEqual([{ name: "request-logging", options: { prefix: "X" } }]);
  });

  test("rejects unsupported storage adapters", () => {
    expect(() => parseServerConfig({ STORAGE_ADAPTER: "sqlite" })).toThrow(/unsupported STORAGE_ADAPTER/);
    expect(() =>
      parseServerConfig({
        MESSAGE_LAYER_CONFIG: JSON.stringify({ storage: { adapter: "sqlite", path: "x" } }),
      }),
    ).toThrow(/unsupported storage.adapter/);
  });

  test("ENABLE_WEBSOCKET=false turns off websocket", () => {
    const cfg = parseServerConfig({ ENABLE_WEBSOCKET: "false" });
    expect(cfg.websocket).toBe(false);
  });

  test("malformed MESSAGE_LAYER_CONFIG is a clear error", () => {
    expect(() => parseServerConfig({ MESSAGE_LAYER_CONFIG: "not-json" })).toThrow(/not valid JSON/);
  });
});
