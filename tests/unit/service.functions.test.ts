import { describe, expect, test } from "vitest";

import { connect } from "../../src/db.js";
import { MessageLayer, PermissionError } from "../../src/service.js";
import type { Principal } from "../../src/types.js";

async function withService<T>(fn: (svc: MessageLayer) => Promise<T>): Promise<T> {
  const db = await connect("memory://unit-functions");
  const svc = new MessageLayer(db);
  try {
    return await fn(svc);
  } finally {
    await db.close?.();
  }
}

describe("service function-level tests (no mocks)", () => {
  test("rejects unsupported message part types", async () => {
    await withService(async (svc) => {
      const orgId = await svc.createOrg("Acme");
      const adminId = await svc.createActor(orgId, "human", "admin");
      const admin: Principal = {
        actorId: adminId,
        orgId,
        scopes: ["channel:create", "message:append"],
        provider: "local",
      };
      const channelId = await svc.createChannel(admin, "general");

      await expect(
        svc.appendMessage(admin, {
          streamId: channelId,
          streamType: "channel",
          parts: [{ type: "invalid_part" as never, payload: { text: "nope" } }],
          idempotencyKey: "bad-part-1",
        }),
      ).rejects.toThrowError();
    });
  });

  test("enforces org isolation for actor principals", async () => {
    await withService(async (svc) => {
      const orgA = await svc.createOrg("OrgA");
      const orgB = await svc.createOrg("OrgB");
      const actorA = await svc.createActor(orgA, "human", "a");

      const principalFromWrongOrg: Principal = {
        actorId: actorA,
        orgId: orgB,
        scopes: ["channel:create"],
        provider: "local",
      };

      await expect(svc.createChannel(principalFromWrongOrg, "forbidden")).rejects.toBeInstanceOf(PermissionError);
    });
  });

  test("revokeGrant blocks future append attempts", async () => {
    await withService(async (svc) => {
      const orgId = await svc.createOrg("Acme");
      const adminId = await svc.createActor(orgId, "human", "admin");
      const userId = await svc.createActor(orgId, "human", "user");

      const admin: Principal = {
        actorId: adminId,
        orgId,
        scopes: ["grant:create", "channel:create"],
        provider: "local",
      };
      const user: Principal = {
        actorId: userId,
        orgId,
        scopes: [],
        provider: "local",
      };

      const channelId = await svc.createChannel(admin, "ops");
      const grantId = await svc.createGrant(admin, userId, "channel", channelId, "message:append");

      await svc.appendMessage(user, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "before revoke" } }],
        idempotencyKey: "before-revoke",
      });

      await svc.revokeGrant(admin, grantId);

      await expect(
        svc.appendMessage(user, {
          streamId: channelId,
          streamType: "channel",
          parts: [{ type: "text", payload: { text: "after revoke" } }],
          idempotencyKey: "after-revoke",
        }),
      ).rejects.toBeInstanceOf(PermissionError);
    });
  });
});
