import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Binary / blob storage for artifacts.
 *
 * The core only stores artifact *metadata* in SQL (AGENTS.md rule #14: file
 * storage is external). Actual bytes go through a pluggable `StorageAdapter`
 * so deployments can swap local FS for S3 / R2 / MinIO without touching the
 * service layer.
 *
 * Two adapters ship in v1:
 *   - `memory`    — used for tests and ephemeral runs
 *   - `local-fs`  — default for dev; writes under a base directory
 *
 * External adapters (S3 etc.) implement the same interface and plug in via
 * `ServerConfig.artifacts`.
 */

export type StorageKind = "memory" | "local-fs";

export interface StoredObject {
  content: Buffer;
  contentType: string;
  size: number;
}

export interface StorageAdapter {
  readonly kind: StorageKind;
  put(key: string, content: Buffer, opts: { contentType: string }): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

// ── in-memory (tests / ephemeral) ─────────────────────────────────────────

export class InMemoryStorageAdapter implements StorageAdapter {
  readonly kind: StorageKind = "memory";
  private readonly blobs = new Map<string, StoredObject>();

  async put(key: string, content: Buffer, opts: { contentType: string }): Promise<void> {
    this.blobs.set(key, {
      content: Buffer.from(content),
      contentType: opts.contentType,
      size: content.byteLength,
    });
  }

  async get(key: string): Promise<StoredObject | null> {
    const hit = this.blobs.get(key);
    if (!hit) return null;
    return { content: Buffer.from(hit.content), contentType: hit.contentType, size: hit.size };
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

// ── local filesystem (default dev) ────────────────────────────────────────

/**
 * Writes content under `<basePath>/<storageKey>` and stores a sidecar
 * `<storageKey>.meta.json` with the content type. Keys are validated to
 * prevent directory traversal.
 */
export class LocalFileSystemStorageAdapter implements StorageAdapter {
  readonly kind: StorageKind = "local-fs";
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = resolve(basePath);
  }

  private safePath(key: string): string {
    if (!key || key.includes("..") || key.startsWith("/") || key.startsWith("\\")) {
      throw new Error(`invalid storage key: ${key}`);
    }
    const full = resolve(this.basePath, key);
    if (!full.startsWith(this.basePath + "/") && full !== this.basePath) {
      throw new Error(`invalid storage key (escape attempt): ${key}`);
    }
    return full;
  }

  async put(key: string, content: Buffer, opts: { contentType: string }): Promise<void> {
    const path = this.safePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    await writeFile(`${path}.meta.json`, JSON.stringify({ contentType: opts.contentType, size: content.byteLength }));
  }

  async get(key: string): Promise<StoredObject | null> {
    const path = this.safePath(key);
    try {
      const [content, metaRaw] = await Promise.all([readFile(path), readFile(`${path}.meta.json`, "utf8")]);
      const meta = JSON.parse(metaRaw) as { contentType: string; size: number };
      return { content, contentType: meta.contentType, size: meta.size ?? content.byteLength };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.safePath(key);
    await Promise.all([
      rm(path, { force: true }),
      rm(`${path}.meta.json`, { force: true }),
    ]);
  }
}

// ── factory / config helpers ──────────────────────────────────────────────

export interface StorageConfig {
  kind: StorageKind;
  /** Required when kind === "local-fs". Absolute or relative path. */
  basePath?: string;
  /** Maximum artifact size in bytes. Defaults to 10 MB. */
  maxBytes?: number;
}

export const DEFAULT_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;

export function createStorageAdapter(config: StorageConfig): StorageAdapter {
  if (config.kind === "memory") return new InMemoryStorageAdapter();
  if (config.kind === "local-fs") {
    if (!config.basePath) throw new Error("artifacts.basePath is required for local-fs");
    return new LocalFileSystemStorageAdapter(config.basePath);
  }
  throw new Error(`unsupported storage kind: ${config.kind as string}`);
}

export function deriveStorageKey(orgId: string, artifactId: string): string {
  // Namespace objects by org so an adapter shared across deployments or orgs
  // cannot cross-read content, and so listing a bucket by prefix is cheap.
  return `${orgId}/${artifactId.slice(0, 2)}/${artifactId}`;
}
