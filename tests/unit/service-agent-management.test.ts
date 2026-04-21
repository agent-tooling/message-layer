import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOrg, createServiceHarness, principalFor } from "../helpers/harness.js";
import { NotFoundError, PermissionError } from "../../src/types.js";

/**
 * Agent management — the operator-facing surface: "kick this agent", "show
 * me everything it did". Built on primitives that already existed
 * (grants, audit log) without adding any new agent-specific tables.
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

describe("revokeAllGrantsForActor", () => {
  test("flips every live grant held by an actor to inactive + emits one event each", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");

    const g1 = await harness.service.createGrant(admin, bot.actorId, "channel", channelId, "message:append");
    const g2 = await harness.service.createGrant(admin, bot.actorId, "channel", channelId, "artifact:register");
    const g3 = await harness.service.createGrant(admin, bot.actorId, "org", orgId, "channel:create");

    const received: Array<Record<string, unknown>> = [];
    harness.bus.subscribe((e) => {
      if (e.type === "grant.revoked") received.push(e.payload as Record<string, unknown>);
    });

    const result = await harness.service.revokeAllGrantsForActor(admin, bot.actorId, "kicking bot");
    expect(new Set(result.revokedGrantIds)).toEqual(new Set([g1, g2, g3]));

    expect(received).toHaveLength(3);
    for (const payload of received) {
      expect(payload).toMatchObject({ actorId: bot.actorId, reason: "kicking bot", bulk: true });
    }

    // The actor can no longer act on any of the previously-granted things.
    expect(await harness.service.checkGrant(orgId, bot.actorId, "message:append")).toBe(false);
    expect(await harness.service.checkGrant(orgId, bot.actorId, "artifact:register")).toBe(false);
    expect(await harness.service.checkGrant(orgId, bot.actorId, "channel:create")).toBe(false);
  });

  test("is idempotent: calling twice when there's nothing live returns empty", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const bot = await principalFor(harness.service, orgId, "bot", "agent");
    const r1 = await harness.service.revokeAllGrantsForActor(admin, bot.actorId);
    const r2 = await harness.service.revokeAllGrantsForActor(admin, bot.actorId);
    expect(r1.revokedGrantIds).toEqual([]);
    expect(r2.revokedGrantIds).toEqual([]);
  });

  test("rejects non-admin callers with a PermissionError", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const bot = await principalFor(harness.service, orgId, "bot", "agent");
    const intruder = await principalFor(harness.service, orgId, "intruder");
    await harness.service.createGrant(admin, bot.actorId, "org", orgId, "channel:create");

    await expect(harness.service.revokeAllGrantsForActor(intruder, bot.actorId)).rejects.toBeInstanceOf(PermissionError);
  });

  test("refuses to cross org boundaries", async () => {
    const a = await bootstrapOrg(harness.service, "A");
    const b = await bootstrapOrg(harness.service, "B");

    await expect(
      harness.service.revokeAllGrantsForActor(a.admin, b.adminActorId),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  test("NotFoundError when the target actor does not exist", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    await expect(harness.service.revokeAllGrantsForActor(admin, "bogus-actor-id")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("auditRows filters", () => {
  test("actorId filter returns rows where the actor is the subject OR the operator", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");
    await harness.service.createGrant(admin, bot.actorId, "channel", channelId, "message:append");

    await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "bot says hi" } }],
      idempotencyKey: "audit-1",
    });

    const justBot = await harness.service.auditRows(orgId, { actorId: bot.actorId });
    const types = justBot.map((r) => r.eventType);
    // The bot shows up: as the subject of the grant, as the author of the
    // message, and via the membership event from actor creation.
    expect(types).toContain("grant.created");
    expect(types).toContain("message.appended");
    expect(types).toContain("membership.updated");

    // Rows not involving the bot should be absent.
    const orgCreation = justBot.find((r) => r.eventType === "org.created");
    expect(orgCreation).toBeUndefined();
  });

  test("limit returns the most recent N rows only", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    for (let i = 0; i < 10; i++) {
      await harness.service.appendMessage(admin, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: `msg ${i}` } }],
        idempotencyKey: `limit-${i}`,
      });
    }
    const full = await harness.service.auditRows(orgId);
    const limited = await harness.service.auditRows(orgId, { limit: 5 });
    expect(limited).toHaveLength(5);
    expect(limited[limited.length - 1].id).toBe(full[full.length - 1].id);
  });

  test("audit hash chain still verifies over the full chain, regardless of slice", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");
    await harness.service.createGrant(admin, bot.actorId, "channel", channelId, "message:append");
    await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "trail" } }],
      idempotencyKey: "hash-1",
    });

    await harness.service.auditRows(orgId, { actorId: bot.actorId, limit: 2 });
    const verify = await harness.service.verifyAuditChain(orgId);
    expect(verify.valid).toBe(true);
  });
});
