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

describe("service.createGrant / revokeGrant", () => {
  test("admin can grant then revoke; capability effect mirrors state", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const bob = await principalFor(harness.service, orgId, "bob");

    expect(await harness.service.checkGrant(orgId, bob.actorId, "channel:create")).toBe(false);
    const grantId = await harness.service.createGrant(admin, bob.actorId, "org", orgId, "channel:create");
    expect(await harness.service.checkGrant(orgId, bob.actorId, "channel:create")).toBe(true);
    await harness.service.revokeGrant(admin, grantId);
    expect(await harness.service.checkGrant(orgId, bob.actorId, "channel:create")).toBe(false);
  });

  test("revoking unknown grant is a NotFoundError", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    await expect(harness.service.revokeGrant(admin, "nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  test("creator must have grant:create scope or meta-grant", async () => {
    const { orgId } = await bootstrapOrg(harness.service);
    const bob = await principalFor(harness.service, orgId, "bob");
    await expect(
      harness.service.createGrant(bob, bob.actorId, "org", orgId, "channel:create"),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  test("createGrant validates required fields", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    await expect(harness.service.createGrant(admin, "", "org", null, "cap")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("service.createPermissionRequest / resolve", () => {
  test("open -> approve creates matching grant, request marked approved", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const bob = await principalFor(harness.service, orgId, "bob");
    const channelId = await harness.service.createChannel(admin, "room", "public");
    const reqId = await harness.service.createPermissionRequest(bob, "message:append", "channel", channelId);
    const { status, grantId } = await harness.service.resolvePermissionRequest(admin, reqId, true);
    expect(status).toBe("approved");
    expect(grantId).toMatch(/^[0-9a-f]{32}$/);
    expect(await harness.service.checkGrant(orgId, bob.actorId, "message:append")).toBe(true);
  });

  test("open -> deny leaves no grant", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const bob = await principalFor(harness.service, orgId, "bob");
    const channelId = await harness.service.createChannel(admin, "room", "public");
    const reqId = await harness.service.createPermissionRequest(bob, "message:append", "channel", channelId);
    const { status, grantId } = await harness.service.resolvePermissionRequest(admin, reqId, false, "no thanks");
    expect(status).toBe("denied");
    expect(grantId).toBeNull();
    expect(await harness.service.checkGrant(orgId, bob.actorId, "message:append")).toBe(false);
  });

  test("resolving a non-open request rejects with ValidationError", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const bob = await principalFor(harness.service, orgId, "bob");
    const channelId = await harness.service.createChannel(admin, "room", "public");
    const reqId = await harness.service.createPermissionRequest(bob, "message:append", "channel", channelId);
    await harness.service.resolvePermissionRequest(admin, reqId, true);
    await expect(harness.service.resolvePermissionRequest(admin, reqId, true)).rejects.toBeInstanceOf(ValidationError);
  });

  test("listOpenPermissionRequests only returns open rows for the principal's org", async () => {
    const orgA = await bootstrapOrg(harness.service, "A");
    const orgB = await bootstrapOrg(harness.service, "B");
    const chan = await harness.service.createChannel(orgA.admin, "r", "public");
    const bob = await principalFor(harness.service, orgA.orgId, "bob");
    const r1 = await harness.service.createPermissionRequest(bob, "message:append", "channel", chan);
    const chanB = await harness.service.createChannel(orgB.admin, "r", "public");
    await harness.service.createPermissionRequest(orgB.admin, "message:append", "channel", chanB);

    const rowsA = await harness.service.listOpenPermissionRequests(orgA.orgId);
    expect(rowsA.map((r) => r.requestId)).toContain(r1);
    const rowsB = await harness.service.listOpenPermissionRequests(orgB.orgId);
    expect(rowsB.map((r) => r.requestId)).not.toContain(r1);
  });
});
