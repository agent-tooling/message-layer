import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOrg, createServiceHarness, principalFor } from "../helpers/harness.js";
import { NotFoundError, PermissionError, ValidationError } from "../../src/types.js";

let harness: Awaited<ReturnType<typeof createServiceHarness>>;

beforeEach(async () => {
  harness = await createServiceHarness();
});
afterEach(async () => {
  await harness.close();
});

describe("service.createChannel", () => {
  test("creates a private channel + owner membership", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    const channelId = await harness.service.createChannel(admin, "general");
    const rows = await harness.db.query<{ visibility: string }>(
      "SELECT visibility FROM channels WHERE id=?",
      [channelId],
    );
    expect(rows.rows[0].visibility).toBe("private");
    const members = await harness.service.listChannelMembers(admin, channelId);
    expect(members.map((m) => m.actorId)).toContain(admin.actorId);
  });

  test("denies principals without channel:create scope", async () => {
    const { orgId } = await bootstrapOrg(harness.service);
    const alice = await principalFor(harness.service, orgId, "alice");
    await expect(harness.service.createChannel(alice, "forbidden")).rejects.toBeInstanceOf(PermissionError);
  });

  test("enforces org membership", async () => {
    const orgA = await bootstrapOrg(harness.service, "A");
    const orgB = await bootstrapOrg(harness.service, "B");
    const wrongOrg = { ...orgA.admin, orgId: orgB.orgId };
    await expect(harness.service.createChannel(wrongOrg, "x")).rejects.toBeInstanceOf(PermissionError);
  });

  test("rejects invalid visibility", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    // @ts-expect-error deliberate invalid
    await expect(harness.service.createChannel(admin, "n", "weird")).rejects.toBeInstanceOf(Error);
  });
});

describe("service.listChannels privacy", () => {
  test("public channels are visible to all org members; private are not", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const pub = await harness.service.createChannel(admin, "public-room", "public");
    const priv = await harness.service.createChannel(admin, "private-room", "private");
    const bob = await principalFor(harness.service, orgId, "bob");
    const visible = await harness.service.listChannels(bob);
    const ids = visible.map((c) => c.id);
    expect(ids).toContain(pub);
    expect(ids).not.toContain(priv);
  });
});

describe("service.addChannelMember / removeChannelMember", () => {
  test("channel owner can add a member, who can then read private channel", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const priv = await harness.service.createChannel(admin, "secret", "private");
    const bob = await principalFor(harness.service, orgId, "bob");

    await expect(harness.service.listMessages(bob, priv, { streamType: "channel" })).rejects.toBeInstanceOf(PermissionError);

    await harness.service.addChannelMember(admin, priv, bob.actorId);
    const msgs = await harness.service.listMessages(bob, priv, { streamType: "channel" });
    expect(msgs).toEqual([]);
  });

  test("non-admin cannot add others", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const pub = await harness.service.createChannel(admin, "room", "public");
    const bob = await principalFor(harness.service, orgId, "bob");
    const carol = await principalFor(harness.service, orgId, "carol");
    await expect(harness.service.addChannelMember(bob, pub, carol.actorId)).rejects.toBeInstanceOf(PermissionError);
  });

  test("actor can self-remove from a channel", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const pub = await harness.service.createChannel(admin, "room", "public");
    const bob = await principalFor(harness.service, orgId, "bob");
    await harness.service.addChannelMember(admin, pub, bob.actorId);
    await harness.service.removeChannelMember(bob, pub, bob.actorId);
    const members = await harness.service.listChannelMembers(admin, pub);
    expect(members.map((m) => m.actorId)).not.toContain(bob.actorId);
  });

  test("adding unknown actor fails", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    const pub = await harness.service.createChannel(admin, "room", "public");
    await expect(harness.service.addChannelMember(admin, pub, "no-such-actor")).rejects.toBeInstanceOf(NotFoundError);
  });

  test("adding actor from another org fails", async () => {
    const orgA = await bootstrapOrg(harness.service, "A");
    const orgB = await bootstrapOrg(harness.service, "B");
    const chanA = await harness.service.createChannel(orgA.admin, "roomA", "private");
    await expect(harness.service.addChannelMember(orgA.admin, chanA, orgB.adminActorId)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("service.createThread", () => {
  test("creates thread anchored to a message in same channel", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    const channelId = await harness.service.createChannel(admin, "general");
    const msg = await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "parent" } }],
      idempotencyKey: "p-1",
    });
    if ("denied" in msg && msg.denied) throw new Error("unexpected denial");
    const threadId = await harness.service.createThread(admin, channelId, msg.messageId);
    const threads = await harness.service.listThreads(admin, channelId);
    expect(threads.map((t) => t.id)).toContain(threadId);
  });

  test("fails if parent message is in a different channel", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    const a = await harness.service.createChannel(admin, "a");
    const b = await harness.service.createChannel(admin, "b");
    const msg = await harness.service.appendMessage(admin, {
      streamId: a,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "in a" } }],
      idempotencyKey: "p-1",
    });
    if ("denied" in msg && msg.denied) throw new Error("unexpected");
    await expect(harness.service.createThread(admin, b, msg.messageId)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("service.deleteChannel", () => {
  test("channel admin can delete a channel with its thread data", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    const channelId = await harness.service.createChannel(admin, "cleanup-room", "private");
    const root = await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "root" } }],
      idempotencyKey: "delete-channel-root",
    });
    if ("denied" in root && root.denied) throw new Error("unexpected denial");
    const threadId = await harness.service.createThread(admin, channelId, root.messageId, "private");
    await harness.service.appendMessage(admin, {
      streamId: threadId,
      streamType: "thread",
      parts: [{ type: "text", payload: { text: "thread-reply" } }],
      idempotencyKey: "delete-channel-thread-reply",
    });

    await harness.service.deleteChannel(admin, channelId);

    const channels = await harness.service.listChannels(admin);
    expect(channels.map((channel) => channel.id)).not.toContain(channelId);
    await expect(
      harness.service.listMessages(admin, channelId, { streamType: "channel" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      harness.service.listMessages(admin, threadId, { streamType: "thread" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("non-admin cannot delete channels they do not own", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const channelId = await harness.service.createChannel(admin, "cannot-delete-me", "private");
    const bob = await principalFor(harness.service, orgId, "bob");
    await expect(harness.service.deleteChannel(bob, channelId)).rejects.toBeInstanceOf(PermissionError);
  });
});
