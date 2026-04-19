import type { StorageAdapter } from "./db.js";

export type PluginConfigEntry = string | {
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

export function defaultServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const adapter = parseStorageAdapter(env.STORAGE_ADAPTER);
  return {
    port: Number(env.PORT ?? "3000"),
    storage: {
      adapter,
      path: env.STORAGE_PATH ?? (adapter === "sqlite" ? ":memory:" : "memory://server"),
    },
    plugins: parsePluginsFromEnv(env.PLUGINS),
  };
}

export function parseServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const raw = env.MESSAGE_LAYER_CONFIG;
  if (!raw) {
    return defaultServerConfig(env);
  }

  const parsed = JSON.parse(raw) as Partial<ServerConfig>;
  const defaults = defaultServerConfig(env);

  return {
    port: parsed.port ?? defaults.port,
    storage: {
      adapter: parsed.storage?.adapter ?? defaults.storage.adapter,
      path: parsed.storage?.path ?? defaults.storage.path,
    },
    plugins: parsed.plugins ?? defaults.plugins,
  };
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return parseServerConfig(env);
}
