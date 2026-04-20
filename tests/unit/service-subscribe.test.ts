import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOrg, createServiceHarness, principalFor } from "../helpers/harness.js";
import { PermissionError } from "../../src/types.js";

let harness: Awaited<ReturnType<typeof createServiceHarness>>;

beforeEach(async () => {
  harness = await createServiceHarness();
});
afterEach(async () => {
  await harness.close();
});

describe("service.subscribe", () => {
  test("returns events with monotonic stream_seq for the stream", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    const channelId = await harness.service.createChannel(admin, "general", "public");
    await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "1" } }],
      idempotencyKey: "a",
    });
    await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "2" } }],
      idempotencyKey: "b",
    });
    const events = await harness.service.subscribe(admin, channelId);
    const seqs = events.filter((e) => e.type === "message.appended").map((e) => e.streamSeq);
    expect(seqs).toEqual([1, 2]);
  });

  test("fromSeq filters out already-seen events", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    const channelId = await harness.service.createChannel(admin, "general", "public");
    for (const i of [1, 2, 3]) {
      await harness.service.appendMessage(admin, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: `m${i}` } }],
        idempotencyKey: `k-${i}`,
      });
    }
    const events = await harness.service.subscribe(admin, channelId, { fromSeq: 2 });
    expect(events.map((e) => e.streamSeq)).toEqual([3]);
  });

  test("private channel non-member subscription is rejected", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const priv = await harness.service.createChannel(admin, "secret", "private");
    const bob = await principalFor(harness.service, orgId, "bob");
    await expect(harness.service.subscribe(bob, priv)).rejects.toBeInstanceOf(PermissionError);
  });
});
