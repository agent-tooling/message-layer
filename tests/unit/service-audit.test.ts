import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOrg, createServiceHarness } from "../helpers/harness.js";
import { stableJson } from "../../src/service.js";

let harness: Awaited<ReturnType<typeof createServiceHarness>>;

beforeEach(async () => {
  harness = await createServiceHarness();
});
afterEach(async () => {
  await harness.close();
});

describe("audit hash chain", () => {
  test("every row's event_hash matches sha256(prev|type|payload|createdAt)", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const channelId = await harness.service.createChannel(admin, "general", "public");
    await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "hello" } }],
      idempotencyKey: "a",
    });
    const rows = await harness.service.auditRows(orgId);
    expect(rows.length).toBeGreaterThan(2);
    let prev = "";
    for (const row of rows) {
      const expected = createHash("sha256")
        .update(`${prev}|${row.eventType}|${stableJson(row.payload)}|${row.createdAt}`)
        .digest("hex");
      expect(row.eventHash).toBe(expected);
      prev = row.eventHash;
    }
    expect(await harness.service.verifyAuditChain(orgId)).toEqual({ valid: true, firstBadIndex: null, total: rows.length });
  });

  test("tampering with a row is detected", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const channelId = await harness.service.createChannel(admin, "general", "public");
    await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "hello" } }],
      idempotencyKey: "a",
    });
    await harness.db.query("UPDATE audit_events SET payload_json='{\"tampered\":true}' WHERE org_id=? AND audit_seq=1", [orgId]);
    const result = await harness.service.verifyAuditChain(orgId);
    expect(result.valid).toBe(false);
    expect(result.firstBadIndex).toBe(0);
  });

  test("audit is org-scoped and appended on every emit event", async () => {
    const orgA = await bootstrapOrg(harness.service, "A");
    const orgB = await bootstrapOrg(harness.service, "B");
    await harness.service.createChannel(orgA.admin, "x", "public");
    await harness.service.createChannel(orgB.admin, "y", "public");
    const a = await harness.service.auditRows(orgA.orgId);
    const b = await harness.service.auditRows(orgB.orgId);
    const aTypes = new Set(a.map((r) => r.eventType));
    const bTypes = new Set(b.map((r) => r.eventType));
    expect(aTypes.has("channel.created")).toBe(true);
    expect(bTypes.has("channel.created")).toBe(true);
    // Org A never saw anything from Org B.
    expect(a.every((row) => (row.payload.orgId as string) === orgA.orgId)).toBe(true);
    expect(b.every((row) => (row.payload.orgId as string) === orgB.orgId)).toBe(true);
  });
});
