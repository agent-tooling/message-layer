import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOrg, createServiceHarness } from "../helpers/harness.js";
import { NotFoundError, ValidationError } from "../../src/types.js";

let harness: Awaited<ReturnType<typeof createServiceHarness>>;

beforeEach(async () => {
  harness = await createServiceHarness();
});
afterEach(async () => {
  await harness.close();
});

describe("service.createOrg", () => {
  test("creates an org and emits org.created + membership events", async () => {
    const events: string[] = [];
    harness.bus.subscribe((e) => events.push(e.type));

    const orgId = await harness.service.createOrg("Acme");
    expect(orgId).toMatch(/^[0-9a-f]{32}$/);
    expect(events).toContain("org.created");
  });

  test("rejects empty name", async () => {
    await expect(harness.service.createOrg("")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("service.createActor", () => {
  test("creates actor and org-scope membership", async () => {
    const { orgId } = await bootstrapOrg(harness.service);
    const actorId = await harness.service.createActor(orgId, "agent", "bot");
    const members = await harness.db.query<{ actor_id: string; role: string }>(
      "SELECT actor_id, role FROM memberships WHERE org_id=? AND actor_id=? AND channel_id IS NULL",
      [orgId, actorId],
    );
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0].role).toBe("member");
  });

  test("rejects invalid actor type", async () => {
    const { orgId } = await bootstrapOrg(harness.service);
    await expect(
      // @ts-expect-error deliberate invalid
      harness.service.createActor(orgId, "robot", "bot"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects unknown org", async () => {
    await expect(harness.service.createActor("nope", "human", "x")).rejects.toBeInstanceOf(NotFoundError);
  });
});
