import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InMemoryStorageAdapter } from "../../src/storage.js";
import { NotFoundError, PermissionError, ValidationError } from "../../src/types.js";
import { bootstrapOrg, createServiceHarness, principalFor } from "../helpers/harness.js";

let harness: Awaited<ReturnType<typeof createServiceHarness>>;

beforeEach(async () => {
  harness = await createServiceHarness();
});
afterEach(async () => {
  await harness.close();
});

async function bootstrapChannel(scoped: "public" | "private" = "public") {
  const { orgId, admin } = await bootstrapOrg(harness.service);
  const channelId = await harness.service.createChannel(admin, "general", scoped);
  return { orgId, admin, channelId };
}

describe("service.registerArtifact", () => {
  test("stores bytes, persists metadata, and emits artifact.registered", async () => {
    const { admin, channelId } = await bootstrapChannel();
    const content = Buffer.from("hello world", "utf8");
    const expectedSha = createHash("sha256").update(content).digest("hex");

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, payload: e.payload }));

    const record = await harness.service.registerArtifact(admin, {
      streamId: channelId,
      streamType: "channel",
      filename: "hello.txt",
      contentType: "text/plain",
      content,
    });

    expect(record.size).toBe(content.byteLength);
    expect(record.sha256).toBe(expectedSha);
    expect(record.filename).toBe("hello.txt");
    expect(record.contentType).toBe("text/plain");
    expect(record.deleted).toBe(false);

    const download = await harness.service.downloadArtifact(admin, record.id);
    expect(download.content.toString("utf8")).toBe("hello world");
    expect(download.metadata.id).toBe(record.id);

    const event = received.find((e) => e.type === "artifact.registered");
    expect(event).toBeDefined();
    expect(event?.payload).toMatchObject({
      artifactId: record.id,
      streamId: channelId,
      contentType: "text/plain",
      size: content.byteLength,
      sha256: expectedSha,
    });
  });

  test("validates sha256 when supplied", async () => {
    const { admin, channelId } = await bootstrapChannel();
    await expect(
      harness.service.registerArtifact(admin, {
        streamId: channelId,
        streamType: "channel",
        filename: "x.bin",
        contentType: "application/octet-stream",
        content: Buffer.from("abc"),
        sha256: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects empty content and over-cap content", async () => {
    const { admin, channelId } = await bootstrapChannel();
    await expect(
      harness.service.registerArtifact(admin, {
        streamId: channelId,
        streamType: "channel",
        filename: "empty",
        contentType: "application/octet-stream",
        content: Buffer.alloc(0),
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const oversize = await createServiceHarness();
    try {
      // Force a tiny limit via a fresh MessageLayer instance — done through a
      // dedicated service to avoid mutating the shared harness.
      const { MessageLayer } = await import("../../src/service.js");
      const small = new MessageLayer(oversize.db, { bus: oversize.bus, maxArtifactBytes: 8, storage: new InMemoryStorageAdapter() });
      const { orgId, admin: smallAdmin } = await bootstrapOrg(small);
      const channelId = await small.createChannel(smallAdmin, "c", "public");
      await expect(
        small.registerArtifact(smallAdmin, {
          streamId: channelId,
          streamType: "channel",
          filename: "big",
          contentType: "application/octet-stream",
          content: Buffer.alloc(16, 0x41),
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      // reference orgId to quiet unused var
      expect(orgId).toBeTypeOf("string");
    } finally {
      await oversize.close();
    }
  });

  test("denies principals without message:append or artifact:register", async () => {
    const { orgId, channelId } = await bootstrapChannel("public");
    const bob = await principalFor(harness.service, orgId, "bob");
    await expect(
      harness.service.registerArtifact(bob, {
        streamId: channelId,
        streamType: "channel",
        filename: "hi.txt",
        contentType: "text/plain",
        content: Buffer.from("hi"),
      }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  test("artifact:register grant alone is sufficient", async () => {
    const { admin, orgId, channelId } = await bootstrapChannel("public");
    const bob = await principalFor(harness.service, orgId, "bob");
    await harness.service.createGrant(admin, bob.actorId, "channel", channelId, "artifact:register");
    const record = await harness.service.registerArtifact(bob, {
      streamId: channelId,
      streamType: "channel",
      filename: "note.txt",
      contentType: "text/plain",
      content: Buffer.from("granted"),
    });
    expect(record.createdByActorId).toBe(bob.actorId);
  });

  test("private channel membership is required even with scope", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel("private");
    const bot = await principalFor(harness.service, orgId, "bot", "agent", ["message:append", "artifact:register"]);
    await expect(
      harness.service.registerArtifact(bot, {
        streamId: channelId,
        streamType: "channel",
        filename: "spy.bin",
        contentType: "application/octet-stream",
        content: Buffer.from("peek"),
      }),
    ).rejects.toBeInstanceOf(PermissionError);
    await harness.service.addChannelMember(admin, channelId, bot.actorId);
    const record = await harness.service.registerArtifact(bot, {
      streamId: channelId,
      streamType: "channel",
      filename: "allowed.bin",
      contentType: "application/octet-stream",
      content: Buffer.from("peek"),
    });
    expect(record.id).toBeTruthy();
  });
});

describe("service.listArtifacts / getArtifactMetadata", () => {
  test("lists live artifacts in insertion order; hides deleted by default", async () => {
    const { admin, channelId } = await bootstrapChannel();
    const a = await harness.service.registerArtifact(admin, {
      streamId: channelId,
      streamType: "channel",
      filename: "a.txt",
      contentType: "text/plain",
      content: Buffer.from("a"),
    });
    const b = await harness.service.registerArtifact(admin, {
      streamId: channelId,
      streamType: "channel",
      filename: "b.txt",
      contentType: "text/plain",
      content: Buffer.from("b"),
    });
    await harness.service.deleteArtifact(admin, a.id);
    const live = await harness.service.listArtifacts(admin, channelId);
    expect(live.map((r) => r.id)).toEqual([b.id]);
    const all = await harness.service.listArtifacts(admin, channelId, { includeDeleted: true });
    expect(all.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(all.find((r) => r.id === a.id)?.deleted).toBe(true);
  });

  test("non-member of private channel cannot read metadata or content", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel("private");
    const artifact = await harness.service.registerArtifact(admin, {
      streamId: channelId,
      streamType: "channel",
      filename: "secret.txt",
      contentType: "text/plain",
      content: Buffer.from("secret"),
    });
    const alice = await principalFor(harness.service, orgId, "alice");
    await expect(harness.service.getArtifactMetadata(alice, artifact.id)).rejects.toBeInstanceOf(PermissionError);
    await expect(harness.service.downloadArtifact(alice, artifact.id)).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("service.deleteArtifact", () => {
  test("emits artifact.deleted; download becomes NotFound", async () => {
    const { admin, channelId } = await bootstrapChannel();
    const received: string[] = [];
    harness.bus.subscribe((e) => received.push(e.type));
    const record = await harness.service.registerArtifact(admin, {
      streamId: channelId,
      streamType: "channel",
      filename: "tmp.bin",
      contentType: "application/octet-stream",
      content: Buffer.from("tmp"),
    });
    await harness.service.deleteArtifact(admin, record.id, "cleanup");
    expect(received).toContain("artifact.deleted");
    await expect(harness.service.downloadArtifact(admin, record.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("only creator / artifact:admin / matching grant can delete", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel("public");
    const bob = await principalFor(harness.service, orgId, "bob");
    await harness.service.createGrant(admin, bob.actorId, "channel", channelId, "message:append");
    const record = await harness.service.registerArtifact(bob, {
      streamId: channelId,
      streamType: "channel",
      filename: "mine.bin",
      contentType: "application/octet-stream",
      content: Buffer.from("bob"),
    });
    const carol = await principalFor(harness.service, orgId, "carol");
    await expect(harness.service.deleteArtifact(carol, record.id)).rejects.toBeInstanceOf(PermissionError);
    // creator can
    await harness.service.deleteArtifact(bob, record.id);
  });
});
