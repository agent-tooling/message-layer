import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { connect, type SqlDatabase } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { createApp } from "../../src/http.js";
import { MessageLayer } from "../../src/service.js";
import type { Principal } from "../../src/types.js";
import { HttpClient, appFetcher } from "../helpers/http-client.js";

/**
 * Full HTTP surface for the fine-grained approval workflow:
 *   - POST /v1/messages with autoRequestOnDeny opens a contextful request
 *   - POST /v1/permission-requests/:id/resolve accepts { maxUses, expiresAt }
 *   - The issued grant is exactly as restrictive as the resolver asked for
 *   - GET  /v1/permission-requests returns the stored context so a UI can
 *     render an accordion with the agent's actual args
 */

let db: SqlDatabase;
let http: HttpClient;
let app: ReturnType<typeof createApp>;

async function bootstrap(): Promise<{ orgId: string; admin: Principal; channelId: string; bot: Principal }> {
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
    scopes: ["channel:create", "grant:create"],
    provider: "test",
  };
  const botPrincipal: Principal = { actorId: bot.body.actorId, orgId: org.body.orgId, scopes: [], provider: "test" };
  const ch = await http.post<{ channelId: string }>("/v1/channels", { name: "room", visibility: "public" }, adminPrincipal);
  return { orgId: org.body.orgId, admin: adminPrincipal, channelId: ch.body.channelId, bot: botPrincipal };
}

beforeEach(async () => {
  db = await connect(`memory://approve-${Math.random().toString(16).slice(2)}`);
  const bus = new InProcessEventBus();
  const service = new MessageLayer(db, { bus });
  app = createApp(service);
  http = new HttpClient("http://localhost", appFetcher(app));
});
afterEach(async () => {
  await db.close?.();
});

describe("HTTP / approval modes", () => {
  test("approve once: first retry succeeds, second opens a fresh request", async () => {
    const { admin, channelId, bot } = await bootstrap();

    const auto = await http.post<{ denied: boolean; requestId: string }>(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "from agent" } }],
        idempotencyKey: "m-1",
        autoRequestOnDeny: true,
      },
      bot,
    );
    expect(auto.body.denied).toBe(true);

    const resolved = await http.post<{ status: string }>(
      `/v1/permission-requests/${auto.body.requestId}/resolve`,
      { approve: true, maxUses: 1 },
      admin,
    );
    expect(resolved.body.status).toBe("approved");

    const ok = await http.post<{ messageId: string }>(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "first" } }],
        idempotencyKey: "m-2",
      },
      bot,
    );
    expect(ok.status).toBe(200);

    const again = await http.post<{ denied: boolean; requestId: string }>(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "second" } }],
        idempotencyKey: "m-3",
        autoRequestOnDeny: true,
      },
      bot,
    );
    expect(again.body.denied).toBe(true);
    expect(again.body.requestId).not.toBe(auto.body.requestId);
  });

  test("approve with expiresAt: grant stops working after the window", async () => {
    const { admin, channelId, bot } = await bootstrap();
    const auto = await http.post<{ requestId: string }>(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "time-boxed" } }],
        idempotencyKey: "t-1",
        autoRequestOnDeny: true,
      },
      bot,
    );
    const expiresAt = new Date(Date.now() + 900).toISOString();
    await http.post(`/v1/permission-requests/${auto.body.requestId}/resolve`, { approve: true, expiresAt }, admin);
    const soon = await http.post<{ messageId: string }>(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "in window" } }],
        idempotencyKey: "t-2",
      },
      bot,
    );
    expect(soon.status).toBe(200);

    await new Promise((r) => setTimeout(r, 1_200));

    const late = await http.post<{ code: string }>(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "after" } }],
        idempotencyKey: "t-3",
      },
      bot,
    );
    expect(late.status).toBe(403);
    expect(late.body.code).toBe("PERMISSION_DENIED");
  });

  test("listing open requests returns the stored context for the UI", async () => {
    const { admin, channelId, bot } = await bootstrap();
    await http.post(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "surface me" } }],
        idempotencyKey: "c-1",
        autoRequestOnDeny: true,
      },
      bot,
    );

    const listed = await http.get<{
      requests: Array<{
        requestId: string;
        action: string;
        context: { kind?: string; streamId?: string; parts?: Array<{ text?: string }> };
      }>;
    }>(`/v1/permission-requests?actorId=${bot.actorId}`, admin);
    expect(listed.body.requests).toHaveLength(1);
    const row = listed.body.requests[0];
    expect(row.action).toBe("message:append");
    expect(row.context.kind).toBe("message.append");
    expect(row.context.streamId).toBe(channelId);
    expect(row.context.parts?.[0].text).toBe("surface me");
  });

  test("rejects maxUses: 0 / expiresAt in the past at validation time", async () => {
    const { admin, channelId, bot } = await bootstrap();
    const auto = await http.post<{ requestId: string }>(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "bad" } }],
        idempotencyKey: "v-1",
        autoRequestOnDeny: true,
      },
      bot,
    );
    const bad = await http.post<{ code: string }>(
      `/v1/permission-requests/${auto.body.requestId}/resolve`,
      { approve: true, maxUses: 0 },
      admin,
    );
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("VALIDATION");
  });
});
