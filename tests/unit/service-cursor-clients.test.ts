import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOrg, createServiceHarness } from "../helpers/harness.js";
import { ValidationError } from "../../src/types.js";

let harness: Awaited<ReturnType<typeof createServiceHarness>>;

beforeEach(async () => {
  harness = await createServiceHarness();
});
afterEach(async () => {
  await harness.close();
});

describe("service.updateCursor / getCursor", () => {
  test("round-trips cursor values and emits cursor.updated", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    const channelId = await harness.service.createChannel(admin, "general", "public");
    const received: number[] = [];
    harness.bus.subscribe((e) => {
      if (e.type === "cursor.updated") received.push((e.payload as { lastSeenSeq: number }).lastSeenSeq);
    });
    await harness.service.updateCursor(admin, channelId, 5, 4);
    const read = await harness.service.getCursor(admin, channelId);
    expect(read).toEqual({ lastSeenSeq: 5, lastAckSeq: 4, updatedAt: expect.any(String) });
    expect(received).toEqual([5]);
  });

  test("validates non-negative seq values", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    const channelId = await harness.service.createChannel(admin, "general", "public");
    await expect(harness.service.updateCursor(admin, channelId, -1, 0)).rejects.toBeInstanceOf(ValidationError);
  });

  test("returns null for unseen cursor", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    expect(await harness.service.getCursor(admin, "no-stream")).toBeNull();
  });
});

describe("service.registerClient", () => {
  test("creates a client record and emits client.registered", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    let got: string | null = null;
    harness.bus.subscribe((e) => {
      if (e.type === "client.registered") got = (e.payload as { clientId: string }).clientId;
    });
    const clientId = await harness.service.registerClient(admin, "wss://ios", { platform: "ios" });
    expect(clientId).toBe(got);
  });

  test("validates required endpoint", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    await expect(harness.service.registerClient(admin, "")).rejects.toBeInstanceOf(ValidationError);
  });
});
