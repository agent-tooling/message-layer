/**
 * FakeS3Server — a minimal, in-process S3-compatible HTTP server for tests.
 *
 * No Docker. No external processes. Pure Node.js `http` module.
 *
 * Implements just enough of the S3 REST API to exercise `S3StorageAdapter`:
 *   PUT    /<bucket>/<key>   PutObject
 *   GET    /<bucket>/<key>   GetObject
 *   DELETE /<bucket>/<key>   DeleteObject
 *   PUT    /<bucket>          CreateBucket (no-op, returns 200)
 *
 * Signature verification is intentionally skipped — this is for tests only.
 * Start one server per test suite, stop it in afterAll.
 *
 * @example
 * ```typescript
 * import { FakeS3Server } from "../helpers/fake-s3-server.js";
 * import { S3StorageAdapter } from "../../src/storage/s3.js";
 *
 * const fake = new FakeS3Server();
 * await fake.start();
 *
 * const adapter = new S3StorageAdapter({
 *   bucket: "test-bucket",
 *   endpoint: fake.endpoint,
 *   forcePathStyle: true,
 *   credentials: { accessKeyId: "fakekey", secretAccessKey: "fakesecret" },
 * });
 *
 * // … run tests …
 * await fake.stop();
 * ```
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type StoredBlob = {
  content: Buffer;
  contentType: string;
  lastModified: string;
};

export class FakeS3Server {
  private readonly blobs = new Map<string, StoredBlob>();
  private readonly srv = createServer((req, res) => this.handleRequest(req, res));

  /** The base URL of the server once started, e.g. `http://127.0.0.1:45321`. */
  get endpoint(): string {
    const addr = this.srv.address() as AddressInfo | null;
    if (!addr) throw new Error("FakeS3Server: not started yet");
    return `http://127.0.0.1:${addr.port}`;
  }

  /** Number of objects currently stored. Useful for assertions. */
  get size(): number {
    return this.blobs.size;
  }

  /** Start the server on a random port. Resolves when bound. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.srv.once("error", reject);
      this.srv.listen(0, "127.0.0.1", () => resolve());
    });
  }

  /** Stop the server and release the port. */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if ("closeAllConnections" in this.srv) {
        (this.srv as { closeAllConnections(): void }).closeAllConnections();
      }
      this.srv.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** Dump all stored keys (for debugging). */
  keys(): string[] {
    return [...this.blobs.keys()];
  }

  // ── request dispatch ─────────────────────────────────────────────────────

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Path: /<bucket>/<key> or /<bucket>
    const parts = url.pathname.replace(/^\//, "").split("/");
    const bucket = parts[0];
    const key = parts.slice(1).join("/");

    if (!bucket) {
      res.writeHead(400, { "content-type": "application/xml" });
      res.end(xmlError("InvalidRequest", "No bucket specified"));
      return;
    }

    switch (req.method) {
      case "PUT":
        if (!key) {
          // CreateBucket — just acknowledge
          res.writeHead(200, { "content-type": "application/xml" });
          res.end();
        } else {
          this.handlePut(req, res, bucket, key);
        }
        break;
      case "GET":
        if (!key) {
          this.handleList(res, bucket);
        } else {
          this.handleGet(res, bucket, key);
        }
        break;
      case "DELETE":
        this.handleDelete(req, res, bucket, key);
        break;
      case "HEAD":
        this.handleHead(res, bucket, key);
        break;
      default:
        res.writeHead(405, { "content-type": "application/xml" });
        res.end(xmlError("MethodNotAllowed", `method ${req.method} not supported`));
    }
  }

  private handlePut(
    req: IncomingMessage,
    res: ServerResponse,
    bucket: string,
    key: string,
  ): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const content = Buffer.concat(chunks);
      const contentType =
        (req.headers["content-type"] as string | undefined) ?? "application/octet-stream";
      const storeKey = `${bucket}/${key}`;
      this.blobs.set(storeKey, { content, contentType, lastModified: new Date().toUTCString() });
      res.writeHead(200, {
        etag: `"${Buffer.from(storeKey).toString("hex").slice(0, 32)}"`,
        "content-length": "0",
      });
      res.end();
    });
    req.on("error", () => {
      res.writeHead(500);
      res.end();
    });
  }

  private handleGet(res: ServerResponse, bucket: string, key: string): void {
    const blob = this.blobs.get(`${bucket}/${key}`);
    if (!blob) {
      res.writeHead(404, { "content-type": "application/xml" });
      res.end(xmlError("NoSuchKey", `The specified key does not exist: ${key}`));
      return;
    }
    res.writeHead(200, {
      "content-type": blob.contentType,
      "content-length": String(blob.content.byteLength),
      "last-modified": blob.lastModified,
      etag: `"${blob.content.byteLength.toString(16)}"`,
    });
    res.end(blob.content);
  }

  private handleHead(res: ServerResponse, bucket: string, key: string): void {
    const blob = this.blobs.get(`${bucket}/${key}`);
    if (!blob) {
      res.writeHead(404, { "content-type": "application/xml" });
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": blob.contentType,
      "content-length": String(blob.content.byteLength),
      "last-modified": blob.lastModified,
    });
    res.end();
  }

  private handleDelete(
    req: IncomingMessage,
    res: ServerResponse,
    bucket: string,
    key: string,
  ): void {
    // Consume body (AWS SDK may send a body for DeleteObjects batch)
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      this.blobs.delete(`${bucket}/${key}`);
      res.writeHead(204);
      res.end();
    });
  }

  private handleList(res: ServerResponse, bucket: string): void {
    const prefix = `${bucket}/`;
    const objects = [...this.blobs.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => `<Contents><Key>${k.slice(prefix.length)}</Key><Size>${v.content.byteLength}</Size></Contents>`)
      .join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult><Name>${bucket}</Name>${objects}</ListBucketResult>`;
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(xml);
  }
}

function xmlError(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}
