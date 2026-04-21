import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOrg, createServiceHarness, principalFor } from "../helpers/harness.js";
import { PermissionError, ValidationError } from "../../src/types.js";

/**
 * Approval modes — AGENTS.md rule 5 ("permissions are scoped, time-bounded,
 * purpose-aware"). A human resolving a permission request can choose:
 *
 *   1. Approve once        — maxUses: 1
 *   2. Approve for N min   — expiresAt: <ISO>
 *   3. Approve forever     — both null (default)
 *   4. Deny                — no grant is issued
 *
 * Every mode lands the decision on the shared bus and in the hash-chained
 * per-org audit log so policy plugins and auditors can see exactly what
 * the human agreed to.
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

describe("resolvePermissionRequest approval modes", () => {
  test("approve once: first append succeeds, second retry re-enters the deny path", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");

    // Agent tries to post, gets an auto-request back.
    const denied = await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "hi" } }],
      idempotencyKey: "bot-1",
      autoRequestOnDeny: true,
    });
    if (!("denied" in denied) || !denied.denied) throw new Error("expected denial");

    const resolved = await harness.service.resolvePermissionRequest(admin, denied.requestId, true, { maxUses: 1 });
    expect(resolved.status).toBe("approved");
    expect(resolved.grantId).toBeTruthy();

    // First use consumes the only allowed use.
    const ok = await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "first" } }],
      idempotencyKey: "bot-2",
    });
    if ("denied" in ok && ok.denied) throw new Error("unexpected denial");
    expect(ok.streamSeq).toBeGreaterThan(0);

    // Second attempt falls back to deny; the original grant is exhausted.
    await expect(
      harness.service.appendMessage(bot, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "second" } }],
        idempotencyKey: "bot-3",
      }),
    ).rejects.toBeInstanceOf(PermissionError);

    // And autoRequestOnDeny on the second attempt opens a fresh request,
    // proving the permanent grant was not silently reused.
    const again = await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "third" } }],
      idempotencyKey: "bot-4",
      autoRequestOnDeny: true,
    });
    if (!("denied" in again) || !again.denied) throw new Error("expected second denial");
    expect(again.requestId).not.toBe(denied.requestId);
  });

  test("approve with expiresAt: grant stops working after the timestamp passes", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");

    const denied = await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "hi" } }],
      idempotencyKey: "exp-1",
      autoRequestOnDeny: true,
    });
    if (!("denied" in denied) || !denied.denied) throw new Error("expected denial");

    // One second in the future — long enough to append once, short enough
    // to wait out in the test without being slow.
    const expiresAt = new Date(Date.now() + 1_200).toISOString();
    await harness.service.resolvePermissionRequest(admin, denied.requestId, true, { expiresAt });

    const ok = await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "within window" } }],
      idempotencyKey: "exp-2",
    });
    if ("denied" in ok && ok.denied) throw new Error("unexpected denial");

    await new Promise((r) => setTimeout(r, 1_500));

    await expect(
      harness.service.appendMessage(bot, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "after expiry" } }],
        idempotencyKey: "exp-3",
      }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  test("approve forever: multiple uses keep succeeding; grant stays active", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");

    const denied = await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "hi" } }],
      idempotencyKey: "forever-1",
      autoRequestOnDeny: true,
    });
    if (!("denied" in denied) || !denied.denied) throw new Error("expected denial");

    await harness.service.resolvePermissionRequest(admin, denied.requestId, true, {});

    for (let i = 0; i < 5; i++) {
      const ok = await harness.service.appendMessage(bot, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: `msg-${i}` } }],
        idempotencyKey: `forever-msg-${i}`,
      });
      if ("denied" in ok && ok.denied) throw new Error(`unexpected denial at iteration ${i}`);
    }
  });

  test("deny: no grant is issued; actor still cannot append", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");

    const denied = await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "pls" } }],
      idempotencyKey: "deny-1",
      autoRequestOnDeny: true,
    });
    if (!("denied" in denied) || !denied.denied) throw new Error("expected denial");

    const resolved = await harness.service.resolvePermissionRequest(admin, denied.requestId, false, { notes: "no thanks" });
    expect(resolved.status).toBe("denied");
    expect(resolved.grantId).toBeNull();

    await expect(
      harness.service.appendMessage(bot, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "still no" } }],
        idempotencyKey: "deny-2",
      }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  test("maxUses must be a positive integer", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    await expect(
      harness.service.createGrant(admin, admin.actorId, "org", admin.orgId, "noop", null, {}, 0),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      harness.service.createGrant(admin, admin.actorId, "org", admin.orgId, "noop", null, {}, -5),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      harness.service.createGrant(admin, admin.actorId, "org", admin.orgId, "noop", null, {}, 2.5),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("expiresAt must be ISO-8601", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    await expect(
      harness.service.createGrant(admin, admin.actorId, "org", admin.orgId, "noop", "not-a-date", {}, null),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("approval resolved event carries expiresAt + maxUses for plugins", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");
    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, payload: e.payload }));

    const denied = await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "hi" } }],
      idempotencyKey: "ev-1",
      autoRequestOnDeny: true,
    });
    if (!("denied" in denied) || !denied.denied) throw new Error("expected denial");
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await harness.service.resolvePermissionRequest(admin, denied.requestId, true, { maxUses: 3, expiresAt });

    const resolved = received.find((e) => e.type === "permission_request.resolved");
    expect(resolved).toBeDefined();
    expect(resolved?.payload).toMatchObject({ status: "approved", maxUses: 3, expiresAt });
  });
});
