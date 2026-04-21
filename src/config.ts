import type { SqlAdapter } from "./db.js";
import type { StorageConfig, StorageKind } from "./storage.js";
import { DEFAULT_ARTIFACT_MAX_BYTES } from "./storage.js";

export type PluginConfigEntry = string | {
  name: string;
  options?: Record<string, unknown>;
};

export type ServerConfig = {
  port: number;
  storage: {
    adapter: SqlAdapter;
    path: string;
  };
  /**
   * Blob storage configuration for artifacts. Metadata lives in SQL; bytes
   * go here. Default is `local-fs` under `./.data/artifacts`.
   */
  artifacts: StorageConfig;
  plugins: PluginConfigEntry[];
  /** Enable WebSocket upgrade on the HTTP server. Defaults to `true`. */
  websocket: boolean;
};

function parseStorageAdapter(value: string | undefined): SqlAdapter {
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

function parseArtifactsStorageKind(value: string | undefined): StorageKind {
  if (!value) return "local-fs";
  if (value === "memory" || value === "local-fs") return value;
  throw new Error(`unsupported ARTIFACTS_STORAGE: ${value}. Supported: memory, local-fs`);
}

function defaultArtifactsConfig(env: NodeJS.ProcessEnv): StorageConfig {
  const kind = parseArtifactsStorageKind(env.ARTIFACTS_STORAGE);
  const maxBytes = env.ARTIFACTS_MAX_BYTES ? Number(env.ARTIFACTS_MAX_BYTES) : DEFAULT_ARTIFACT_MAX_BYTES;
  if (kind === "memory") {
    return { kind, maxBytes };
  }
  return {
    kind: "local-fs",
    basePath: env.ARTIFACTS_PATH ?? "./.data/artifacts",
    maxBytes,
  };
}

export function defaultServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const adapter = parseStorageAdapter(env.STORAGE_ADAPTER);
  return {
    port: Number(env.PORT ?? "3000"),
    storage: {
      adapter,
      path: env.STORAGE_PATH ?? "memory://server",
    },
    artifacts: defaultArtifactsConfig(env),
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

  const artifactsRaw = (parsed as Partial<ServerConfig>).artifacts;
  const artifacts: StorageConfig = artifactsRaw
    ? {
        kind: parseArtifactsStorageKind(artifactsRaw.kind),
        basePath: artifactsRaw.basePath ?? defaults.artifacts.basePath,
        maxBytes: artifactsRaw.maxBytes ?? defaults.artifacts.maxBytes,
      }
    : defaults.artifacts;

  return {
    port: parsed.port ?? defaults.port,
    storage: {
      adapter,
      path: parsed.storage?.path ?? defaults.storage.path,
    },
    artifacts,
    plugins: parsed.plugins ?? defaults.plugins,
    websocket: parsed.websocket ?? defaults.websocket,
  };
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return parseServerConfig(env);
}
