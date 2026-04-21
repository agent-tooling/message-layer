import { describe, expect, test } from "vitest";
import { defaultServerConfig, parseServerConfig } from "../../src/config.js";

describe("config", () => {
  test("defaults to pglite at port 3000 with websocket enabled", () => {
    const cfg = defaultServerConfig({});
    expect(cfg).toMatchObject({
      port: 3000,
      storage: { adapter: "pglite", path: "memory://server" },
      artifacts: { kind: "local-fs", basePath: "./.data/artifacts" },
      plugins: [],
      websocket: true,
    });
    expect(cfg.artifacts.maxBytes).toBeGreaterThan(0);
  });

  test("ARTIFACTS_STORAGE=memory switches to in-memory blob storage", () => {
    const cfg = parseServerConfig({
      ARTIFACTS_STORAGE: "memory",
      ARTIFACTS_MAX_BYTES: "1024",
    });
    expect(cfg.artifacts.kind).toBe("memory");
    expect(cfg.artifacts.maxBytes).toBe(1024);
  });

  test("rejects unsupported ARTIFACTS_STORAGE", () => {
    expect(() => parseServerConfig({ ARTIFACTS_STORAGE: "gcs" })).toThrow(
      /unsupported ARTIFACTS_STORAGE/,
    );
  });

  test("parses PLUGINS env shorthand into objects", () => {
    const cfg = parseServerConfig({ PLUGINS: "request-logging,health-meta" });
    expect(cfg.plugins).toEqual([
      { name: "request-logging" },
      { name: "health-meta" },
    ]);
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
    expect(cfg.plugins).toEqual([
      { name: "request-logging", options: { prefix: "X" } },
    ]);
  });

  test("rejects unsupported storage adapters", () => {
    expect(() => parseServerConfig({ STORAGE_ADAPTER: "sqlite" })).toThrow(
      /unsupported STORAGE_ADAPTER/,
    );
    expect(() =>
      parseServerConfig({
        MESSAGE_LAYER_CONFIG: JSON.stringify({
          storage: { adapter: "sqlite", path: "x" },
        }),
      }),
    ).toThrow(/unsupported storage.adapter/);
  });

  test("supports postgres adapter with explicit connection string", () => {
    const cfg = parseServerConfig({
      STORAGE_ADAPTER: "postgres",
      STORAGE_PATH: "postgresql://user:pass@localhost:5432/db",
    });
    expect(cfg.storage).toEqual({
      adapter: "postgres",
      path: "postgresql://user:pass@localhost:5432/db",
    });
  });

  test("rejects postgres adapter without explicit connection string", () => {
    expect(() => parseServerConfig({ STORAGE_ADAPTER: "postgres" })).toThrow(
      /postgres adapter requires storage.path to be a Postgres connection string/,
    );
  });

  test("ENABLE_WEBSOCKET=false turns off websocket", () => {
    const cfg = parseServerConfig({ ENABLE_WEBSOCKET: "false" });
    expect(cfg.websocket).toBe(false);
  });

  test("malformed MESSAGE_LAYER_CONFIG is a clear error", () => {
    expect(() =>
      parseServerConfig({ MESSAGE_LAYER_CONFIG: "not-json" }),
    ).toThrow(/not valid JSON/);
  });
});
