import { describe, expect, test } from "vitest";
import { createInvite, consumeInvite, listInvites } from "../lib/app-db";

describe("invite persistence", () => {
  test("supports invite creation and single-use consumption", () => {
    const token = `test-${Date.now()}`;
    createInvite({
      token,
      email: "new-user@example.com",
      role: "member",
      inviterUserId: "inviter-1",
      createdAt: new Date().toISOString(),
    });

    const invites = listInvites();
    expect(invites.some((invite) => invite.token === token)).toBe(true);

    const firstConsume = consumeInvite(token, "user-123");
    const secondConsume = consumeInvite(token, "user-456");

    expect(firstConsume?.token).toBe(token);
    expect(secondConsume).toBeNull();
  });
});
