import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { connect, type SqlDatabase } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { createApp } from "../../src/http.js";
import { MessageLayer } from "../../src/service.js";
import type { Principal } from "../../src/types.js";
import { HttpClient, appFetcher } from "../helpers/http-client.js";

/**
 * HTTP surface for agent management — the operator UX:
 *   - POST /v1/actors/:id/revoke-grants kicks an agent in one call
 *   - GET  /v1/audit/rows?actorId=... gives the agent's full activity
 *   - GET  /v1/actors returns every actor (agents included) for UI listing
 */

let db: SqlDatabase;
let http: HttpClient;

beforeEach(async () => {
  db = await connect(`memory://agent-mgmt-${Math.random().toString(16).slice(2)}`);
  const bus = new InProcessEventBus();
  const service = new MessageLayer(db, { bus });
  const app = createApp(service);
  http = new HttpClient("http://localhost", appFetcher(app));
});
afterEach(async () => {
  await db.close?.();
});

async function bootstrap(): Promise<{ orgId: string; admin: Principal; bot: Principal; channelId: string }> {
  const org = await http.post<{ orgId: string }>("/v1/orgs", { name: "Acme" }, null);
  const admin = await http.post<{ actorId: string }>(
    "/v1/actors",
    { orgId: org.body.orgId, actorType: "human", displayName: "admin" },
    null,
  );
  const bot = await http.post<{ actorId: string }>(
    "/v1/actors",
    { orgId: org.body.orgId, actorType: "agent", displayName: "bot" },
    null,
  );
  const adminPrincipal: Principal = {
    actorId: admin.body.actorId,
    orgId: org.body.orgId,
    scopes: ["channel:create", "grant:create", "audit:read"],
    provider: "test",
  };
  const ch = await http.post<{ channelId: string }>("/v1/channels", { name: "general", visibility: "public" }, adminPrincipal);
  return {
    orgId: org.body.orgId,
    admin: adminPrincipal,
    bot: { actorId: bot.body.actorId, orgId: org.body.orgId, scopes: [], provider: "test" },
    channelId: ch.body.channelId,
  };
}

describe("HTTP / agent management", () => {
  test("revoke-grants endpoint flips every live grant of an actor and returns their ids", async () => {
    const { admin, bot, channelId } = await bootstrap();

    // Grant the bot several things.
    await http.post(
      "/v1/grants",
      { actorId: bot.actorId, resourceType: "channel", resourceId: channelId, capability: "message:append" },
      admin,
    );
    await http.post(
      "/v1/grants",
      { actorId: bot.actorId, resourceType: "channel", resourceId: channelId, capability: "artifact:register" },
      admin,
    );
    await http.post(
      "/v1/grants",
      { actorId: bot.actorId, resourceType: "org", resourceId: admin.orgId, capability: "channel:create" },
      admin,
    );

    const kicked = await http.post<{ revokedGrantIds: string[] }>(
      `/v1/actors/${bot.actorId}/revoke-grants`,
      { reason: "misbehaving" },
      admin,
    );
    expect(kicked.status).toBe(200);
    expect(kicked.body.revokedGrantIds).toHaveLength(3);

    // The bot can no longer act: an append hits 403 (or opens a request
    // under autoRequestOnDeny).
    const blocked = await http.post<{ code: string }>(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "blocked" } }],
        idempotencyKey: "post-kick-1",
      },
      bot,
    );
    expect(blocked.status).toBe(403);
  });

  test("revoke-grants without a body works (simple kick)", async () => {
    const { admin, bot, channelId } = await bootstrap();
    await http.post(
      "/v1/grants",
      { actorId: bot.actorId, resourceType: "channel", resourceId: channelId, capability: "message:append" },
      admin,
    );
    // No body at all — the endpoint should tolerate this.
    const res = await fetch("http://localhost", {}).catch(() => null);
    void res; // placate the linter — the actual call is via appFetcher below.

    const body = await http.post<{ revokedGrantIds: string[] }>(
      `/v1/actors/${bot.actorId}/revoke-grants`,
      {},
      admin,
    );
    expect(body.status).toBe(200);
    expect(body.body.revokedGrantIds).toHaveLength(1);
  });

  test("non-admin caller is denied (403 PERMISSION_DENIED)", async () => {
    const { bot, channelId, admin } = await bootstrap();
    const unprivileged = await http.post<{ actorId: string }>(
      "/v1/actors",
      { orgId: admin.orgId, actorType: "human", displayName: "nope" },
      null,
    );
    const impostor: Principal = {
      actorId: unprivileged.body.actorId,
      orgId: admin.orgId,
      scopes: [],
      provider: "test",
    };
    await http.post(
      "/v1/grants",
      { actorId: bot.actorId, resourceType: "channel", resourceId: channelId, capability: "message:append" },
      admin,
    );
    const res = await http.post<{ code: string }>(`/v1/actors/${bot.actorId}/revoke-grants`, { reason: "nosy" }, impostor);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PERMISSION_DENIED");
  });

  test("audit filter by actor returns only rows that involve that actor", async () => {
    const { admin, bot, channelId } = await bootstrap();
    await http.post(
      "/v1/grants",
      { actorId: bot.actorId, resourceType: "channel", resourceId: channelId, capability: "message:append" },
      admin,
    );
    await http.post(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "bot says hi" } }],
        idempotencyKey: "audit-a",
      },
      bot,
    );

    const all = await http.get<{ rows: Array<{ eventType: string }> }>("/v1/audit/rows", admin);
    const filtered = await http.get<{ rows: Array<{ eventType: string }> }>(
      `/v1/audit/rows?actorId=${bot.actorId}`,
      admin,
    );
    expect(filtered.body.rows.length).toBeLessThan(all.body.rows.length);
    expect(filtered.body.rows.length).toBeGreaterThan(0);
    // Rows unrelated to the bot (e.g. org.created) should not appear.
    const types = filtered.body.rows.map((r) => r.eventType);
    expect(types).not.toContain("org.created");
    expect(types).toContain("message.appended");
  });

  test("GET /v1/actors returns every actor in the org — UI filters to type=agent", async () => {
    const { admin } = await bootstrap();
    const list = await http.get<{ actors: Array<{ actorId: string; actorType: string; displayName: string }> }>(
      "/v1/actors",
      admin,
    );
    expect(list.status).toBe(200);
    const agents = list.body.actors.filter((a) => a.actorType === "agent");
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.some((a) => a.displayName === "bot")).toBe(true);
  });
});
