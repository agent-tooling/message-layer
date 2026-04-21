import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOrg, createServiceHarness, principalFor } from "../helpers/harness.js";
import { PermissionError } from "../../src/types.js";

/**
 * Atomic grant consumption — the core correctness guarantee behind
 * "approve once" (maxUses: 1) and "approve N times" (maxUses: N).
 *
 * Two properties we care about:
 *   1. Every successful capability-backed mutation consumes exactly one use.
 *   2. Parallel consumers of a single-use grant never both succeed (no
 *      TOCTOU gap between "is this grant live?" and "consume it").
 *
 * Scopes bypass the counter entirely — they model principal-carried
 * capabilities (admin, service accounts) that aren't rate-limited.
 */

let harness: Awaited<ReturnType<typeof createServiceHarness>>;

beforeEach(async () => {
  harness = await createServiceHarness();
});
afterEach(async () => {
  await harness.close();
});

async function bootstrapChannel() {
  const { orgId, admin } = await bootstrapOrg(harness.service);
  const channelId = await harness.service.createChannel(admin, "general", "public");
  return { orgId, admin, channelId };
}

describe("atomic grant consumption", () => {
  test("maxUses: 3 supports exactly three appends, then denies", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");
    await harness.service.createGrant(admin, bot.actorId, "channel", channelId, "message:append", null, {}, 3);

    for (let i = 0; i < 3; i++) {
      const ok = await harness.service.appendMessage(bot, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: `msg-${i}` } }],
        idempotencyKey: `use-${i}`,
      });
      if ("denied" in ok && ok.denied) throw new Error(`denied at iteration ${i}`);
    }

    await expect(
      harness.service.appendMessage(bot, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "fourth" } }],
        idempotencyKey: "use-4",
      }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  test("grant auto-flips to active=0 when fully consumed (observable to /v1/grants/check)", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");
    await harness.service.createGrant(admin, bot.actorId, "channel", channelId, "message:append", null, {}, 1);

    // Still live before the first use.
    expect(await harness.service.checkGrant(orgId, bot.actorId, "message:append")).toBe(true);

    const ok = await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "once" } }],
      idempotencyKey: "consume-1",
    });
    if ("denied" in ok && ok.denied) throw new Error();

    // After consumption, `checkGrant` should report "no live grant".
    expect(await harness.service.checkGrant(orgId, bot.actorId, "message:append")).toBe(false);
  });

  test("concurrent appends against a maxUses=1 grant: at most one wins", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");
    await harness.service.createGrant(admin, bot.actorId, "channel", channelId, "message:append", null, {}, 1);

    const attempts = Array.from({ length: 8 }, (_, i) =>
      harness.service
        .appendMessage(bot, {
          streamId: channelId,
          streamType: "channel",
          parts: [{ type: "text", payload: { text: `race-${i}` } }],
          idempotencyKey: `race-${i}`,
        })
        .then(
          (r) => ({ ok: true, r }),
          (e) => ({ ok: false, e: e as Error }),
        ),
    );

    const settled = await Promise.all(attempts);
    const wins = settled.filter((s) => s.ok);
    const losses = settled.filter((s) => !s.ok);
    expect(wins.length).toBeGreaterThanOrEqual(1);
    // No more than 1 success is permissible. On PGlite's single-threaded
    // execution model the count will typically be exactly 1.
    expect(wins.length).toBe(1);
    for (const l of losses) {
      expect((l as { e: Error }).e).toBeInstanceOf(PermissionError);
    }
  });

  test("scopes do not decrement a counter (principal with `message:append` scope succeeds forever)", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const scoped = await principalFor(harness.service, orgId, "scoped", "agent", ["message:append"]);
    // Also a maxUses=1 grant on top — we should never consume it while the
    // scope is covering us.
    await harness.service.createGrant(admin, scoped.actorId, "channel", channelId, "message:append", null, {}, 1);

    for (let i = 0; i < 4; i++) {
      const ok = await harness.service.appendMessage(scoped, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: `via-scope-${i}` } }],
        idempotencyKey: `scope-${i}`,
      });
      if ("denied" in ok && ok.denied) throw new Error();
    }

    // The grant should still be unused and live.
    expect(await harness.service.checkGrant(orgId, scoped.actorId, "message:append")).toBe(true);
  });

  test("channel:create consumption: maxUses: 1 allows exactly one channel", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const bot = await principalFor(harness.service, orgId, "bot", "agent");
    await harness.service.createGrant(admin, bot.actorId, "org", orgId, "channel:create", null, {}, 1);

    const id = await harness.service.createChannel(bot, "first", "public");
    expect(id).toBeTruthy();

    await expect(harness.service.createChannel(bot, "second", "public")).rejects.toBeInstanceOf(PermissionError);
  });

  test("exhaustion emits grant.revoked with autoRevoked: true", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");
    await harness.service.createGrant(admin, bot.actorId, "channel", channelId, "message:append", null, {}, 1);

    const events: Array<Record<string, unknown>> = [];
    harness.bus.subscribe((e) => {
      if (e.type === "grant.revoked") events.push(e.payload as Record<string, unknown>);
    });

    await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "burn" } }],
      idempotencyKey: "exhaust-1",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ autoRevoked: true, reason: "max_uses exhausted" });
  });
});
