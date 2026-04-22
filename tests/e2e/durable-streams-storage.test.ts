/**
 * durable-streams-storage plugin e2e tests.
 *
 * Two storage backends are tested:
 *   1. InMemoryStorageAdapter  — always available, no setup required.
 *   2. S3StorageAdapter + FakeS3Server — in-process fake S3, no Docker.
 *
 * Each test boots a full HTTP server so that the plugin routes are exercised
 * over real HTTP calls (no direct service access — AGENTS.md rule #4).
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startServer, type RunningServer } from "../../src/server-runtime.js";
import { FakeS3Server } from "../helpers/fake-s3-server.js";
import { InMemoryStorageAdapter } from "../../src/storage.js";
import type { Principal } from "../../src/types.js";

const BUCKET = "ml-dss-test";

// ── shared HTTP helper ────────────────────────────────────────────────────────

function makeHttp(server: RunningServer) {
  return async function http<T = unknown>(
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
  };
}

// ── shared test suite (storage-backend-agnostic) ──────────────────────────────

async function sharedSuite(server: RunningServer) {
  const http = makeHttp(server);

  // Bootstrap: org, actor, channel
  const { body: org } = await http<{ orgId: string }>("POST", "/v1/orgs", null, { name: "dss-org" });
  const { body: actor } = await http<{ actorId: string }>("POST", "/v1/actors", null, {
    orgId: org.orgId,
    actorType: "agent",
    displayName: "stream-agent",
  });
  const principal: Principal = {
    actorId: actor.actorId,
    orgId: org.orgId,
    scopes: ["channel:create", "message:append"],
    provider: "test",
  };
  const { body: ch } = await http<{ channelId: string }>("POST", "/v1/channels", principal, {
    name: "work",
    visibility: "private",
  });

  return { org, actor, principal, ch };
}

// ── Test suite ────────────────────────────────────────────────────────────────

function defineTests(label: string, getServer: () => RunningServer) {
  describe(label, () => {
    let principal: Principal;
    let channelId: string;

    beforeAll(async () => {
      const ctx = await sharedSuite(getServer());
      principal = ctx.principal;
      channelId = ctx.ch.channelId;
    });

    test("create stream → head shows open", async () => {
      const http = makeHttp(getServer());
      const { body: created } = await http<{ durableStreamId: string; status: string }>(
        "POST",
        "/v1/durable-streams-storage",
        principal,
        { targetStreamId: channelId, targetStreamType: "channel" },
      );
      expect(created.status).toBe("open");

      const { body: head } = await http<{ status: string; chunkCount: number }>(
        "GET",
        `/v1/durable-streams-storage/${created.durableStreamId}/head`,
        principal,
      );
      expect(head.status).toBe("open");
      expect(head.chunkCount).toBe(0);
    });

    test("append chunks → chunks stored in storage adapter", async () => {
      const http = makeHttp(getServer());
      const { body: created } = await http<{ durableStreamId: string }>(
        "POST",
        "/v1/durable-streams-storage",
        principal,
        {},
      );

      const { body: appended } = await http<{ offset: number; appended: number }>(
        "POST",
        `/v1/durable-streams-storage/${created.durableStreamId}/chunks`,
        principal,
        { chunks: [{ text: "hello " }, { text: "world" }] },
      );
      expect(appended.offset).toBe(2);
      expect(appended.appended).toBe(2);
    });

    test("read chunks back in order", async () => {
      const http = makeHttp(getServer());
      const { body: created } = await http<{ durableStreamId: string }>(
        "POST",
        "/v1/durable-streams-storage",
        principal,
        {},
      );
      await http("POST", `/v1/durable-streams-storage/${created.durableStreamId}/chunks`, principal, {
        chunks: [{ text: "chunk-A" }, { text: "chunk-B" }, { text: "chunk-C" }],
      });

      const { body: read } = await http<{
        chunks: Array<{ offset: number; text: string }>;
        upToDate: boolean;
        nextOffset: number;
      }>("GET", `/v1/durable-streams-storage/${created.durableStreamId}/read?offset=0`, principal);

      expect(read.chunks).toHaveLength(3);
      expect(read.chunks[0]!.text).toBe("chunk-A");
      expect(read.chunks[1]!.text).toBe("chunk-B");
      expect(read.chunks[2]!.text).toBe("chunk-C");
      expect(read.upToDate).toBe(true);
    });

    test("partial read with offset", async () => {
      const http = makeHttp(getServer());
      const { body: created } = await http<{ durableStreamId: string }>(
        "POST",
        "/v1/durable-streams-storage",
        principal,
        {},
      );
      await http("POST", `/v1/durable-streams-storage/${created.durableStreamId}/chunks`, principal, {
        chunks: [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }],
      });

      const { body: partial } = await http<{ chunks: Array<{ offset: number; text: string }> }>(
        "GET",
        `/v1/durable-streams-storage/${created.durableStreamId}/read?offset=2&limit=2`,
        principal,
      );
      expect(partial.chunks).toHaveLength(2);
      expect(partial.chunks[0]!.text).toBe("c");
      expect(partial.chunks[1]!.text).toBe("d");
    });

    test("commit assembles chunks and posts to target channel", async () => {
      const http = makeHttp(getServer());
      const { body: created } = await http<{ durableStreamId: string }>(
        "POST",
        "/v1/durable-streams-storage",
        principal,
        { targetStreamId: channelId, targetStreamType: "channel" },
      );

      await http("POST", `/v1/durable-streams-storage/${created.durableStreamId}/chunks`, principal, {
        chunks: [{ text: "line 1\n" }, { text: "line 2\n" }, { text: "line 3" }],
      });

      const { body: commit, status: commitStatus } = await http<{
        status: string;
        committedMessageId: string;
        chunkCount: number;
      }>(
        "POST",
        `/v1/durable-streams-storage/${created.durableStreamId}/commit`,
        principal,
        { idempotencyKey: `commit-${created.durableStreamId}` },
      );
      expect(commitStatus).toBe(200);
      expect(commit.status).toBe("committed");
      expect(typeof commit.committedMessageId).toBe("string");
      expect(commit.chunkCount).toBe(3);

      // Verify the message was posted to the channel
      const { body: msgs } = await http<{ messages: Array<{ id: string; parts: Array<{ type: string; payload: { text?: string } }> }> }>(
        "GET",
        `/v1/streams/${channelId}/messages`,
        principal,
      );
      const committedMsg = msgs.messages.find((m) => m.id === commit.committedMessageId);
      expect(committedMsg).toBeDefined();
      expect(committedMsg!.parts[0]!.payload.text).toBe("line 1\nline 2\nline 3");
    });

    test("commit is idempotent", async () => {
      const http = makeHttp(getServer());
      const { body: created } = await http<{ durableStreamId: string }>(
        "POST",
        "/v1/durable-streams-storage",
        principal,
        { targetStreamId: channelId, targetStreamType: "channel" },
      );
      await http("POST", `/v1/durable-streams-storage/${created.durableStreamId}/chunks`, principal, {
        chunks: [{ text: "idempotent" }],
      });
      const key = `idem-${created.durableStreamId}`;
      const { body: c1 } = await http<{ committedMessageId: string }>(
        "POST",
        `/v1/durable-streams-storage/${created.durableStreamId}/commit`,
        principal,
        { idempotencyKey: key },
      );
      const { body: c2 } = await http<{ committedMessageId: string }>(
        "POST",
        `/v1/durable-streams-storage/${created.durableStreamId}/commit`,
        principal,
        { idempotencyKey: key },
      );
      expect(c1.committedMessageId).toBe(c2.committedMessageId);
    });

    test("close writes manifest and marks stream closed", async () => {
      const http = makeHttp(getServer());
      const { body: created } = await http<{ durableStreamId: string }>(
        "POST",
        "/v1/durable-streams-storage",
        principal,
        {},
      );
      await http("POST", `/v1/durable-streams-storage/${created.durableStreamId}/chunks`, principal, {
        chunks: [{ text: "goodbye" }],
      });

      const { body: closed } = await http<{ status: string; chunkCount: number }>(
        "POST",
        `/v1/durable-streams-storage/${created.durableStreamId}/close`,
        principal,
        {},
      );
      expect(closed.status).toBe("closed");
      expect(closed.chunkCount).toBe(1);

      const { body: head } = await http<{ status: string }>(
        "GET",
        `/v1/durable-streams-storage/${created.durableStreamId}/head`,
        principal,
      );
      expect(head.status).toBe("closed");
    });

    test("cannot append to a closed stream", async () => {
      const http = makeHttp(getServer());
      const { body: created } = await http<{ durableStreamId: string }>(
        "POST",
        "/v1/durable-streams-storage",
        principal,
        {},
      );
      await http("POST", `/v1/durable-streams-storage/${created.durableStreamId}/close`, principal, {});

      const { status } = await http(
        "POST",
        `/v1/durable-streams-storage/${created.durableStreamId}/chunks`,
        principal,
        { chunks: [{ text: "should fail" }] },
      );
      expect(status).toBe(400);
    });

    test("second actor cannot access stream they do not own without grant", async () => {
      const http = makeHttp(getServer());
      // Create second actor in same org
      const org2actor = await http<{ actorId: string }>("POST", "/v1/actors", null, {
        orgId: principal.orgId,
        actorType: "human",
        displayName: "intruder",
      });
      const intruder: Principal = {
        actorId: org2actor.body.actorId,
        orgId: principal.orgId,
        scopes: [],
        provider: "test",
      };

      const { body: created } = await http<{ durableStreamId: string }>(
        "POST",
        "/v1/durable-streams-storage",
        principal,
        {},
      );
      const { status } = await http(
        "GET",
        `/v1/durable-streams-storage/${created.durableStreamId}/head`,
        intruder,
      );
      expect(status).toBe(403);
    });

    test("commit without target stream returns 400", async () => {
      const http = makeHttp(getServer());
      const { body: created } = await http<{ durableStreamId: string }>(
        "POST",
        "/v1/durable-streams-storage",
        principal,
        {}, // no targetStreamId
      );
      const { status } = await http(
        "POST",
        `/v1/durable-streams-storage/${created.durableStreamId}/commit`,
        principal,
        {},
      );
      expect(status).toBe(400);
    });

    test("head on unknown stream returns 404", async () => {
      const http = makeHttp(getServer());
      const { status } = await http("GET", "/v1/durable-streams-storage/nonexistent/head", principal);
      expect(status).toBe(404);
    });
  });
}

// ── Suite A: in-memory storage (default local) ────────────────────────────────

describe("durable-streams-storage plugin", () => {
  let serverMem: RunningServer;

  beforeAll(async () => {
    serverMem = await startServer({
      port: 0,
      logger: () => {},
      storage: new InMemoryStorageAdapter(),
      config: {
        port: 0,
        storage: { adapter: "pglite", path: `memory://dss-mem-${Math.random().toString(16).slice(2)}` },
        artifacts: { kind: "memory" },
        plugins: ["durable-streams-storage"],
      },
    });
  });

  afterAll(() => serverMem.close());

  defineTests("in-memory backend", () => serverMem);
});

// ── Suite B: S3 backend (FakeS3Server, no Docker) ─────────────────────────────

describe("durable-streams-storage plugin (S3 backend via FakeS3Server)", () => {
  let fake: FakeS3Server;
  let serverS3: RunningServer;

  beforeAll(async () => {
    fake = new FakeS3Server();
    await fake.start();

    serverS3 = await startServer({
      port: 0,
      logger: () => {},
      config: {
        port: 0,
        storage: { adapter: "pglite", path: `memory://dss-s3-${Math.random().toString(16).slice(2)}` },
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
        plugins: ["durable-streams-storage"],
      },
    });
  });

  afterAll(async () => {
    await serverS3.close();
    await fake.stop();
  });

  defineTests("S3 backend", () => serverS3);

  test("chunk data is stored in FakeS3Server (not SQL)", async () => {
    // After all tests above, the fake S3 server should have blobs
    expect(fake.size).toBeGreaterThan(0);
    const keys = fake.keys();
    // All keys scoped under the bucket
    expect(keys.every((k) => k.startsWith(`${BUCKET}/`))).toBe(true);
    // dss chunks follow the expected path pattern
    const dssKeys = keys.filter((k) => k.includes("/dss/"));
    expect(dssKeys.length).toBeGreaterThan(0);
  });
});
