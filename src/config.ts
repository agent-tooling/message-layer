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
  /** Enable WebSocket upgrade on the HTTP server. Defaults to `true`. */
  websocket: boolean;
};

function parseStorageAdapter(value: string | undefined): StorageAdapter {
  // v1 supports only `pglite`. Unknown/legacy values (e.g. "sqlite") are
  // coerced to the default and a warning is the caller's responsibility.
  if (value && value !== "pglite") {
    throw new Error(`unsupported STORAGE_ADAPTER: ${value}. Supported: pglite`);
  }
  return "pglite";
}

function parsePluginsFromEnv(value: string | undefined): PluginConfigEntry[] {
  if (!value) return [];
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name }));
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function defaultServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const adapter = parseStorageAdapter(env.STORAGE_ADAPTER);
  return {
    port: Number(env.PORT ?? "3000"),
    storage: {
      adapter,
      path: env.STORAGE_PATH ?? "memory://server",
    },
    plugins: parsePluginsFromEnv(env.PLUGINS),
    websocket: parseBool(env.ENABLE_WEBSOCKET, true),
  };
}

export function parseServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const raw = env.MESSAGE_LAYER_CONFIG;
  if (!raw) return defaultServerConfig(env);

  let parsed: Partial<ServerConfig>;
  try {
    parsed = JSON.parse(raw) as Partial<ServerConfig>;
  } catch {
    throw new Error("MESSAGE_LAYER_CONFIG is not valid JSON");
  }
  const defaults = defaultServerConfig(env);

  const adapter = parsed.storage?.adapter ?? defaults.storage.adapter;
  if (adapter !== "pglite") {
    throw new Error(`unsupported storage.adapter: ${adapter as string}. Supported: pglite`);
  }

  return {
    port: parsed.port ?? defaults.port,
    storage: {
      adapter,
      path: parsed.storage?.path ?? defaults.storage.path,
    },
    plugins: parsed.plugins ?? defaults.plugins,
    websocket: parsed.websocket ?? defaults.websocket,
  };
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return parseServerConfig(env);
}
