import type { SqlAdapter } from "./db.js";
import type { StorageConfig, StorageKind } from "./storage.js";
import { DEFAULT_ARTIFACT_MAX_BYTES } from "./storage.js";

export type PluginConfigEntry =
  | string
  | {
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
};

function parseStorageAdapter(value: string | undefined): SqlAdapter {
  if (!value || value === "pglite") return "pglite";
  if (value === "postgres") return "postgres";
  throw new Error(
    `unsupported STORAGE_ADAPTER: ${value}. Supported: pglite, postgres`,
  );
}

function assertStoragePath(adapter: SqlAdapter, path: string): void {
  if (!path || path.trim().length === 0) {
    throw new Error("storage.path must be non-empty");
  }
  if (adapter === "postgres" && path.startsWith("memory://")) {
    throw new Error(
      "postgres adapter requires storage.path to be a Postgres connection string",
    );
  }
}

function parsePluginsFromEnv(value: string | undefined): PluginConfigEntry[] {
  if (!value) return [];
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name }));
}

function parseArtifactsStorageKind(value: string | undefined): StorageKind {
  if (!value) return "local-fs";
  if (value === "memory" || value === "local-fs" || value === "s3") return value;
  throw new Error(
    `unsupported ARTIFACTS_STORAGE: ${value}. Supported: memory, local-fs, s3`,
  );
}

function defaultArtifactsConfig(env: NodeJS.ProcessEnv): StorageConfig {
  const kind = parseArtifactsStorageKind(env.ARTIFACTS_STORAGE);
  const maxBytes = env.ARTIFACTS_MAX_BYTES
    ? Number(env.ARTIFACTS_MAX_BYTES)
    : DEFAULT_ARTIFACT_MAX_BYTES;
  if (kind === "memory") {
    return { kind, maxBytes };
  }
  if (kind === "s3") {
    const bucket = env.ARTIFACTS_S3_BUCKET;
    if (!bucket) throw new Error("ARTIFACTS_S3_BUCKET is required when ARTIFACTS_STORAGE=s3");
    return {
      kind: "s3",
      maxBytes,
      s3Options: {
        bucket,
        region: env.ARTIFACTS_S3_REGION ?? env.AWS_REGION ?? "us-east-1",
        endpoint: env.ARTIFACTS_S3_ENDPOINT ?? env.S3_ENDPOINT,
        forcePathStyle: env.ARTIFACTS_S3_FORCE_PATH_STYLE === "true" || !!env.ARTIFACTS_S3_ENDPOINT,
        credentials:
          env.ARTIFACTS_S3_ACCESS_KEY_ID && env.ARTIFACTS_S3_SECRET_ACCESS_KEY
            ? {
                accessKeyId: env.ARTIFACTS_S3_ACCESS_KEY_ID,
                secretAccessKey: env.ARTIFACTS_S3_SECRET_ACCESS_KEY,
                sessionToken: env.ARTIFACTS_S3_SESSION_TOKEN,
              }
            : undefined,
      },
    };
  }
  return {
    kind: "local-fs",
    basePath: env.ARTIFACTS_PATH ?? "./.data/artifacts",
    maxBytes,
  };
}

export function defaultServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const adapter = parseStorageAdapter(env.STORAGE_ADAPTER);
  const path = env.STORAGE_PATH ?? "memory://server";
  assertStoragePath(adapter, path);
  return {
    port: Number(env.PORT ?? "3000"),
    storage: {
      adapter,
      path,
    },
    artifacts: defaultArtifactsConfig(env),
    plugins: parsePluginsFromEnv(env.PLUGINS),
  };
}

export function parseServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
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
  if (adapter !== "pglite" && adapter !== "postgres") {
    throw new Error(
      `unsupported storage.adapter: ${adapter as string}. Supported: pglite, postgres`,
    );
  }

  const artifactsRaw = (parsed as Partial<ServerConfig>).artifacts;
  const artifacts: StorageConfig = artifactsRaw
    ? {
        kind: parseArtifactsStorageKind(artifactsRaw.kind),
        basePath: artifactsRaw.basePath ?? defaults.artifacts.basePath,
        s3Options: (artifactsRaw as StorageConfig).s3Options ?? (defaults.artifacts as StorageConfig).s3Options,
        maxBytes: artifactsRaw.maxBytes ?? defaults.artifacts.maxBytes,
      }
    : defaults.artifacts;

  const storagePath = parsed.storage?.path ?? defaults.storage.path;
  assertStoragePath(adapter, storagePath);

  return {
    port: parsed.port ?? defaults.port,
    storage: {
      adapter,
      path: storagePath,
    },
    artifacts,
    plugins: parsed.plugins ?? defaults.plugins,
  };
}

export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  return parseServerConfig(env);
}
