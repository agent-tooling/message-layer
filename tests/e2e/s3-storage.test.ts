/**
 * S3 storage adapter e2e tests.
 *
 * Uses FakeS3Server — a pure Node.js in-process HTTP server that speaks the
 * S3 REST protocol. No Docker, no network, no external dependencies.
 *
 * The real `S3StorageAdapter` + `@aws-sdk/client-s3` make genuine HTTP calls
 * to the fake server, so this exercises the full request/response path.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { S3StorageAdapter } from "../../src/storage/s3.js";
import { FakeS3Server } from "../helpers/fake-s3-server.js";
import { startServer } from "../../src/server-runtime.js";
import type { RunningServer } from "../../src/server-runtime.js";
import type { Principal } from "../../src/types.js";

const BUCKET = "ml-test-bucket";

// ── S3StorageAdapter unit tests (against FakeS3Server) ───────────────────────

describe("S3StorageAdapter (FakeS3Server)", () => {
  let fake: FakeS3Server;
  let adapter: S3StorageAdapter;

  beforeAll(async () => {
    fake = new FakeS3Server();
    await fake.start();
    adapter = new S3StorageAdapter({
      bucket: BUCKET,
      endpoint: fake.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: "fakekey", secretAccessKey: "fakesecret" },
    });
  });

  afterAll(() => fake.stop());

  test("put + get roundtrip", async () => {
    const content = Buffer.from("hello s3 world", "utf8");
    await adapter.put("org1/test/hello.txt", content, { contentType: "text/plain" });
    const result = await adapter.get("org1/test/hello.txt");
    expect(result).not.toBeNull();
    expect(result!.content.toString("utf8")).toBe("hello s3 world");
    expect(result!.contentType).toBe("text/plain");
    expect(result!.size).toBe(content.byteLength);
  });

  test("get returns null for missing key", async () => {
    const result = await adapter.get("org1/test/does-not-exist.bin");
    expect(result).toBeNull();
  });

  test("put overwrites existing key", async () => {
    await adapter.put("org1/test/overwrite.txt", Buffer.from("v1"), { contentType: "text/plain" });
    await adapter.put("org1/test/overwrite.txt", Buffer.from("v2"), { contentType: "text/plain" });
    const result = await adapter.get("org1/test/overwrite.txt");
    expect(result!.content.toString("utf8")).toBe("v2");
  });

  test("delete removes object", async () => {
    await adapter.put("org1/test/to-delete.txt", Buffer.from("bye"), { contentType: "text/plain" });
    expect(await adapter.get("org1/test/to-delete.txt")).not.toBeNull();
    await adapter.delete("org1/test/to-delete.txt");
    expect(await adapter.get("org1/test/to-delete.txt")).toBeNull();
  });

  test("delete on missing key does not throw", async () => {
    await expect(adapter.delete("org1/test/ghost.bin")).resolves.not.toThrow();
  });

  test("preserves binary content (zero bytes)", async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    await adapter.put("org1/test/binary.bin", bytes, { contentType: "application/octet-stream" });
    const result = await adapter.get("org1/test/binary.bin");
    expect(result!.content).toEqual(bytes);
    expect(result!.size).toBe(5);
  });

  test("handles large payload (~500 KB)", async () => {
    const big = Buffer.alloc(500 * 1024, 0xab);
    await adapter.put("org1/test/big.bin", big, { contentType: "application/octet-stream" });
    const result = await adapter.get("org1/test/big.bin");
    expect(result!.size).toBe(500 * 1024);
    expect(result!.content[0]).toBe(0xab);
  });
});

// ── Full-stack: artifacts stored in S3 via startServer ───────────────────────

describe("artifact upload/download with S3 backend (FakeS3Server)", () => {
  let fake: FakeS3Server;
  let server: RunningServer;

  beforeAll(async () => {
    fake = new FakeS3Server();
    await fake.start();

    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        port: 0,
        storage: { adapter: "pglite", path: `memory://s3-test-${Math.random().toString(16).slice(2)}` },
        artifacts: {
          kind: "s3",
          maxBytes: 5 * 1024 * 1024,
          s3Options: {
            bucket: BUCKET,
            endpoint: fake.endpoint,
            forcePathStyle: true,
            credentials: { accessKeyId: "fakekey", secretAccessKey: "fakesecret" },
          },
        },
        plugins: [],
      },
    });
  });

  afterAll(async () => {
    await server.close();
    await fake.stop();
  });

  async function api<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    principal: Principal | null,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (principal) headers["x-principal"] = JSON.stringify(principal);
    const res = await fetch(`${server.address}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  test("artifact bytes are stored in S3 and retrieved correctly", async () => {
    // Bootstrap
    const { body: org } = await api<{ orgId: string }>("POST", "/v1/orgs", null, { name: "test-org" });
    const { body: actor } = await api<{ actorId: string }>("POST", "/v1/actors", null, {
      orgId: org.orgId,
      actorType: "human",
      displayName: "Alice",
    });
    const principal: Principal = {
      actorId: actor.actorId,
      orgId: org.orgId,
      scopes: ["channel:create", "message:append", "artifact:register"],
      provider: "test",
    };
    const { body: ch } = await api<{ channelId: string }>("POST", "/v1/channels", principal, {
      name: "s3-test",
      visibility: "private",
    });

    const originalBytes = Buffer.from("binary content stored in s3", "utf8");
    const { body: uploadRes } = await api<{ artifact: { id: string; sha256: string; size: number } }>(
      "POST",
      "/v1/artifacts",
      principal,
      {
        streamId: ch.channelId,
        streamType: "channel",
        filename: "test.bin",
        contentType: "application/octet-stream",
        contentBase64: originalBytes.toString("base64"),
      },
    );

    expect(uploadRes.artifact.size).toBe(originalBytes.byteLength);
    // Object should be in the fake S3 server
    expect(fake.size).toBeGreaterThan(0);

    // Download via HTTP — goes through S3StorageAdapter → FakeS3Server
    const dlRes = await fetch(
      `${server.address}/v1/artifacts/${uploadRes.artifact.id}/content`,
      { headers: { "x-principal": JSON.stringify(principal) } },
    );
    expect(dlRes.status).toBe(200);
    const downloaded = Buffer.from(await dlRes.arrayBuffer());
    expect(downloaded.toString("utf8")).toBe("binary content stored in s3");
  });

  test("FakeS3Server is seeded by real S3 adapter calls", () => {
    // At least one object was put into fake S3 by the previous test
    expect(fake.size).toBeGreaterThan(0);
    // All keys are namespaced correctly
    const keys = fake.keys();
    for (const k of keys) {
      expect(k.startsWith(`${BUCKET}/`)).toBe(true);
    }
  });
});
