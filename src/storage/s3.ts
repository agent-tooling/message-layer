/**
 * S3-compatible storage adapter for message-layer.
 *
 * Works with AWS S3, Cloudflare R2, MinIO, and any other S3-compatible API.
 * For local development and testing use the `FakeS3Server` helper from
 * `tests/helpers/fake-s3-server.ts` — it starts a real in-process HTTP server
 * that speaks the S3 REST protocol, so no Docker or external services are needed.
 *
 * Import path: `message-layer/storage/s3`
 *
 * @example
 * ```typescript
 * import { startServer } from "message-layer";
 * import { s3 } from "message-layer/storage/s3";
 *
 * await startServer({
 *   config: {
 *     artifacts: s3({
 *       bucket: process.env.S3_BUCKET!,
 *       region: process.env.AWS_REGION ?? "us-east-1",
 *     }),
 *   },
 * });
 * ```
 *
 * @example Local / MinIO
 * ```typescript
 * import { s3, S3StorageAdapter } from "message-layer/storage/s3";
 *
 * const adapter = new S3StorageAdapter({
 *   bucket: "my-bucket",
 *   endpoint: "http://localhost:9000",
 *   forcePathStyle: true,
 *   credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
 * });
 * ```
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { StorageAdapter, StorageConfig, StoredObject } from "../storage.js";

export type S3StorageOptions = {
  /** S3 bucket name. */
  bucket: string;
  /** AWS region. Defaults to `us-east-1`. */
  region?: string;
  /**
   * Custom endpoint URL for S3-compatible APIs (MinIO, R2, localstack, etc.).
   * When set, `forcePathStyle` defaults to `true`.
   */
  endpoint?: string;
  /** Force path-style URLs (`http://endpoint/bucket/key`) instead of virtual hosted-style. */
  forcePathStyle?: boolean;
  /** Static credentials. Falls back to the standard AWS credential chain when omitted. */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** Maximum artifact size in bytes. Defaults to 10 MB. */
  maxBytes?: number;
};

/**
 * S3-backed implementation of `StorageAdapter`.
 *
 * Thread-safe (the AWS SDK client handles connection pooling internally).
 * Content-type is preserved as object metadata (`ContentType` header).
 */
export class S3StorageAdapter implements StorageAdapter {
  readonly kind = "s3" as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3StorageOptions) {
    this.bucket = opts.bucket;
    const clientCfg: S3ClientConfig = {
      region: opts.region ?? "us-east-1",
    };
    if (opts.endpoint) {
      clientCfg.endpoint = opts.endpoint;
      clientCfg.forcePathStyle = opts.forcePathStyle ?? true;
    } else if (opts.forcePathStyle !== undefined) {
      clientCfg.forcePathStyle = opts.forcePathStyle;
    }
    if (opts.credentials) {
      clientCfg.credentials = opts.credentials;
    }
    this.client = new S3Client(clientCfg);
  }

  async put(key: string, content: Buffer, opts: { contentType: string }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ContentType: opts.contentType,
        ContentLength: content.byteLength,
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!res.Body) return null;
      const bytes = await res.Body.transformToByteArray();
      const content = Buffer.from(bytes);
      return {
        content,
        contentType: res.ContentType ?? "application/octet-stream",
        size: content.byteLength,
      };
    } catch (error) {
      if (isNoSuchKeyError(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}

function isNoSuchKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  const code = (error as { Code?: string }).Code;
  return name === "NoSuchKey" || code === "NoSuchKey";
}

// ── config helper (mirrors the pglite / postgres factories) ────────────────

export type S3StorageConfig = StorageConfig & {
  kind: "s3";
  s3Options: S3StorageOptions;
};

/**
 * Creates a `StorageConfig` descriptor for S3.  Pass as `config.artifacts`
 * to `startServer` — the server runtime will instantiate the adapter.
 */
export function s3(opts: S3StorageOptions): S3StorageConfig {
  return {
    kind: "s3",
    maxBytes: opts.maxBytes,
    s3Options: opts,
  };
}
