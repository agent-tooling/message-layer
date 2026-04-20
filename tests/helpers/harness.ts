import { createPgliteDatabase, type SqlDatabase } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { MessageLayer } from "../../src/service.js";
import type { Principal } from "../../src/types.js";

let counter = 0;
function uniqueId(prefix = "ml"): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}-${Math.random().toString(16).slice(2, 8)}`;
}

export async function createServiceHarness(): Promise<{
  db: SqlDatabase;
  service: MessageLayer;
  bus: InProcessEventBus;
  close: () => Promise<void>;
}> {
  const db = await createPgliteDatabase(`memory://${uniqueId("ml-test")}`);
  const bus = new InProcessEventBus();
  const service = new MessageLayer(db, { bus });
  return {
    db,
    service,
    bus,
    close: async () => {
      await db.close?.();
    },
  };
}

export type TestOrg = {
  orgId: string;
  admin: Principal;
  adminActorId: string;
};

export async function bootstrapOrg(service: MessageLayer, name = "Acme"): Promise<TestOrg> {
  const orgId = await service.createOrg(name);
  const adminActorId = await service.createActor(orgId, "human", "admin");
  const admin: Principal = {
    actorId: adminActorId,
    orgId,
    scopes: ["grant:create", "channel:create", "thread:create", "message:append", "audit:read", "channel:admin"],
    provider: "test",
  };
  return { orgId, admin, adminActorId };
}

export async function principalFor(
  service: MessageLayer,
  orgId: string,
  displayName: string,
  actorType: "human" | "agent" | "app" = "human",
  scopes: string[] = [],
): Promise<Principal> {
  const actorId = await service.createActor(orgId, actorType, displayName);
  return { actorId, orgId, scopes, provider: "test" };
}
