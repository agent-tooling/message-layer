import type { StorageAdapter } from "./db.js";

export type PluginConfigEntry = {
  name: string;
  options?: Record<string, unknown>;
};

export type ServerConfig = {
  port: number;
  storage: {
    adapter: StorageAdapter;
    path: string;
  };
  plugins: PluginConfigEntry[];
};

function parseStorageAdapter(value: string | undefined): StorageAdapter {
  return value === "sqlite" ? "sqlite" : "pglite";
}

function parsePluginsFromEnv(value: string | undefined): PluginConfigEntry[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name }));
}

export function defaultServerConfig(): ServerConfig {
  const adapter = parseStorageAdapter(process.env.STORAGE_ADAPTER);
  return {
    port: Number(process.env.PORT ?? "3000"),
    storage: {
      adapter,
      path: process.env.STORAGE_PATH ?? (adapter === "sqlite" ? ":memory:" : "memory://server"),
    },
    plugins: parsePluginsFromEnv(process.env.PLUGINS),
  };
}

export function loadServerConfig(): ServerConfig {
  const raw = process.env.MESSAGE_LAYER_CONFIG;
  if (!raw) {
    return defaultServerConfig();
  }

  const parsed = JSON.parse(raw) as Partial<ServerConfig>;
  const defaults = defaultServerConfig();

  return {
    port: parsed.port ?? defaults.port,
    storage: {
      adapter: parsed.storage?.adapter ?? defaults.storage.adapter,
      path: parsed.storage?.path ?? defaults.storage.path,
    },
    plugins: parsed.plugins ?? defaults.plugins,
  };
}
