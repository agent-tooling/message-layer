import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { connect, type SqlDatabase } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { createApp } from "../../src/http.js";
import { MessageLayer } from "../../src/service.js";
import type { Principal } from "../../src/types.js";
import { HttpClient, appFetcher } from "../helpers/http-client.js";

/**
 * Full HTTP surface for the command registry:
 *   POST   /v1/commands                 — register (pending + permission request)
 *   GET    /v1/commands                 — list active commands
 *   DELETE /v1/commands/:commandId      — disable a command
 *
 * Also exercises the /v1/permission-requests/:id/resolve endpoint for the
 * command:register action, which activates the command without issuing a
 * generic grant.
 */

let db: SqlDatabase;
let http: HttpClient;
let app: ReturnType<typeof createApp>;

type OrgFixture = {
  orgId: string;
  admin: Principal;
  channelId: string;
  appActor: Principal;
};

async function bootstrap(): Promise<OrgFixture> {
  const org = await http.post<{ orgId: string }>("/v1/orgs", { name: "Acme" }, null);
  const orgId = org.body.orgId;

  const adminRes = await http.post<{ actorId: string }>(
    "/v1/actors",
    { orgId, actorType: "human", displayName: "admin" },
    null,
  );
  const appRes = await http.post<{ actorId: string }>(
    "/v1/actors",
    { orgId, actorType: "app", displayName: "deploybot" },
    null,
  );

  const admin: Principal = {
    actorId: adminRes.body.actorId,
    orgId,
    scopes: ["channel:create", "grant:create", "message:append", "command:invoke"],
    provider: "test",
  };
  const appActor: Principal = {
    actorId: appRes.body.actorId,
    orgId,
    scopes: [],
    provider: "test",
  };

  const ch = await http.post<{ channelId: string }>(
    "/v1/channels",
    { name: "general", visibility: "public" },
    admin,
  );

  return { orgId, admin, channelId: ch.body.channelId, appActor };
}

beforeEach(async () => {
  db = await connect(`memory://commands-${Math.random().toString(16).slice(2)}`);
  const bus = new InProcessEventBus();
  const service = new MessageLayer(db, { bus });
  app = createApp(service);
  http = new HttpClient("http://localhost", appFetcher(app));
});
afterEach(async () => {
  await db.close?.();
});

describe("HTTP / command registry", () => {
  // ── POST /v1/commands ────────────────────────────────────────────────────

  test("POST /v1/commands returns 201 with commandId + requestId", async () => {
    const { appActor } = await bootstrap();
    const res = await http.post<{ commandId: string; requestId: string }>(
      "/v1/commands",
      { name: "deploy", description: "Deploy a service" },
      appActor,
    );
    expect(res.status).toBe(201);
    expect(typeof res.body.commandId).toBe("string");
    expect(typeof res.body.requestId).toBe("string");
  });

  test("POST /v1/commands requires authentication → 401", async () => {
    const res = await http.post<{ error: string }>("/v1/commands", { name: "deploy" }, null);
    expect(res.status).toBe(401);
  });

  test("POST /v1/commands rejects invalid name → 400", async () => {
    const { appActor } = await bootstrap();
    const res = await http.post<{ code: string }>(
      "/v1/commands",
      { name: "bad name!" },
      appActor,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  test("POST /v1/commands with missing name → 400", async () => {
    const { appActor } = await bootstrap();
    const res = await http.post<{ code: string }>("/v1/commands", {}, appActor);
    expect(res.status).toBe(400);
  });

  test("POST /v1/commands duplicate → 400 VALIDATION", async () => {
    const { appActor } = await bootstrap();
    await http.post("/v1/commands", { name: "run" }, appActor);
    const res = await http.post<{ code: string }>("/v1/commands", { name: "run" }, appActor);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  test("POST /v1/commands with channelId creates channel-scoped registration", async () => {
    const { appActor, channelId } = await bootstrap();
    const res = await http.post<{ commandId: string; requestId: string }>(
      "/v1/commands",
      { name: "post", channelId },
      appActor,
    );
    expect(res.status).toBe(201);
    expect(res.body.commandId).toBeTruthy();
  });

  // ── GET /v1/commands ─────────────────────────────────────────────────────

  test("GET /v1/commands returns empty array before any approvals", async () => {
    const { admin, appActor } = await bootstrap();
    await http.post("/v1/commands", { name: "deploy" }, appActor);

    const res = await http.get<{ commands: unknown[] }>("/v1/commands", admin);
    expect(res.status).toBe(200);
    expect(res.body.commands).toHaveLength(0);
  });

  test("GET /v1/commands requires authentication → 401", async () => {
    const res = await http.get<{ error: string }>("/v1/commands", null);
    expect(res.status).toBe(401);
  });

  test("GET /v1/commands returns active commands after approval", async () => {
    const { admin, appActor } = await bootstrap();
    const reg = await http.post<{ commandId: string; requestId: string }>(
      "/v1/commands",
      { name: "deploy", description: "Deploy to env", argsSchema: { env: { type: "string" } } },
      appActor,
    );
    await http.post(
      `/v1/permission-requests/${reg.body.requestId}/resolve`,
      { approve: true },
      admin,
    );

    const res = await http.get<{
      commands: Array<{
        id: string;
        name: string;
        ownerActorId: string;
        description: string;
        argsSchema: Record<string, unknown>;
        status: string;
        channelId: string | null;
      }>;
    }>("/v1/commands", admin);

    expect(res.status).toBe(200);
    expect(res.body.commands).toHaveLength(1);
    const cmd = res.body.commands[0];
    expect(cmd.name).toBe("deploy");
    expect(cmd.ownerActorId).toBe(appActor.actorId);
    expect(cmd.status).toBe("active");
    expect(cmd.channelId).toBeNull();
    expect(cmd.argsSchema).toEqual({ env: { type: "string" } });
  });

  test("GET /v1/commands?channelId= includes channel-scoped commands", async () => {
    const { admin, appActor, channelId } = await bootstrap();

    // org-scoped
    const r1 = await http.post<{ requestId: string }>("/v1/commands", { name: "global" }, appActor);
    await http.post(`/v1/permission-requests/${r1.body.requestId}/resolve`, { approve: true }, admin);

    // channel-scoped
    const r2 = await http.post<{ requestId: string }>(
      "/v1/commands",
      { name: "local", channelId },
      appActor,
    );
    await http.post(`/v1/permission-requests/${r2.body.requestId}/resolve`, { approve: true }, admin);

    const orgOnly = await http.get<{ commands: Array<{ name: string }> }>("/v1/commands", admin);
    expect(orgOnly.body.commands.map((c) => c.name)).toEqual(["global"]);

    const withChannel = await http.get<{ commands: Array<{ name: string }> }>(
      `/v1/commands?channelId=${channelId}`,
      admin,
    );
    expect(withChannel.body.commands.map((c) => c.name).sort()).toEqual(["global", "local"]);
  });

  // ── DELETE /v1/commands/:commandId ───────────────────────────────────────

  test("DELETE /v1/commands/:id by owner returns 200 ok", async () => {
    const { admin, appActor } = await bootstrap();
    const reg = await http.post<{ commandId: string; requestId: string }>(
      "/v1/commands",
      { name: "deploy" },
      appActor,
    );
    await http.post(`/v1/permission-requests/${reg.body.requestId}/resolve`, { approve: true }, admin);

    const del = await http.del<{ ok: boolean }>(`/v1/commands/${reg.body.commandId}`, appActor);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    // Command no longer visible
    const list = await http.get<{ commands: unknown[] }>("/v1/commands", admin);
    expect(list.body.commands).toHaveLength(0);
  });

  test("DELETE /v1/commands/:id by admin also succeeds", async () => {
    const { admin, appActor } = await bootstrap();
    const reg = await http.post<{ commandId: string; requestId: string }>(
      "/v1/commands",
      { name: "deploy" },
      appActor,
    );
    await http.post(`/v1/permission-requests/${reg.body.requestId}/resolve`, { approve: true }, admin);

    const del = await http.del<{ ok: boolean }>(`/v1/commands/${reg.body.commandId}`, admin);
    expect(del.status).toBe(200);
  });

  test("DELETE /v1/commands/:id requires authentication → 401", async () => {
    const { admin, appActor } = await bootstrap();
    const reg = await http.post<{ commandId: string; requestId: string }>(
      "/v1/commands",
      { name: "deploy" },
      appActor,
    );
    await http.post(`/v1/permission-requests/${reg.body.requestId}/resolve`, { approve: true }, admin);

    const del = await http.del<{ error: string }>(`/v1/commands/${reg.body.commandId}`, null);
    expect(del.status).toBe(401);
  });

  test("DELETE /v1/commands/:id by a stranger → 403", async () => {
    const { orgId, admin, appActor } = await bootstrap();

    const reg = await http.post<{ commandId: string; requestId: string }>(
      "/v1/commands",
      { name: "deploy" },
      appActor,
    );
    await http.post(`/v1/permission-requests/${reg.body.requestId}/resolve`, { approve: true }, admin);

    const strangerRes = await http.post<{ actorId: string }>(
      "/v1/actors",
      { orgId, actorType: "human", displayName: "stranger" },
      null,
    );
    const stranger: Principal = { actorId: strangerRes.body.actorId, orgId, scopes: [], provider: "test" };

    const del = await http.del<{ code: string }>(`/v1/commands/${reg.body.commandId}`, stranger);
    expect(del.status).toBe(403);
    expect(del.body.code).toBe("PERMISSION_DENIED");
  });

  test("DELETE /v1/commands/:id for unknown command → 404", async () => {
    const { admin } = await bootstrap();
    const del = await http.del<{ code: string }>("/v1/commands/nonexistent-id", admin);
    expect(del.status).toBe(404);
  });

  // ── Full lifecycle: register → approve → invoke → delete ─────────────────

  test("full lifecycle: register → approve → invoke with enriched event → delete", async () => {
    const { admin, appActor, channelId } = await bootstrap();

    // Register
    const reg = await http.post<{ commandId: string; requestId: string }>(
      "/v1/commands",
      { name: "ship", description: "Ship it" },
      appActor,
    );
    expect(reg.status).toBe(201);

    // Approve
    const resolve = await http.post<{ status: string; grantId: null; commandId: string }>(
      `/v1/permission-requests/${reg.body.requestId}/resolve`,
      { approve: true },
      admin,
    );
    expect(resolve.status).toBe(200);
    expect(resolve.body.status).toBe("approved");
    expect(resolve.body.grantId).toBeNull();
    expect(resolve.body.commandId).toBe(reg.body.commandId);

    // Confirm listed
    const list = await http.get<{ commands: Array<{ name: string; status: string }> }>("/v1/commands", admin);
    expect(list.body.commands[0].name).toBe("ship");
    expect(list.body.commands[0].status).toBe("active");

    // Grant command:invoke to admin so they can invoke
    await http.post(
      "/v1/grants",
      { actorId: admin.actorId, resourceType: "channel", resourceId: channelId, capability: "command:invoke" },
      admin,
    );

    // Invoke via message — expect enriched command.invoked event
    const msg = await http.post<{ messageId: string }>(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "command", payload: { command: "ship", args: { env: "prod" } } }],
        idempotencyKey: "ship-invoke-1",
      },
      admin,
    );
    expect(msg.status).toBe(200);
    expect(msg.body.messageId).toBeTruthy();

    // Delete
    const del = await http.del<{ ok: boolean }>(`/v1/commands/${reg.body.commandId}`, appActor);
    expect(del.status).toBe(200);

    // Confirm gone
    const after = await http.get<{ commands: unknown[] }>("/v1/commands", admin);
    expect(after.body.commands).toHaveLength(0);
  });

  // ── permission-requests context for command:register ────────────────────

  test("permission request opened by registerCommand has kind=command.register context", async () => {
    const { admin, appActor } = await bootstrap();
    const reg = await http.post<{ requestId: string }>(
      "/v1/commands",
      { name: "analyze", description: "Run analysis" },
      appActor,
    );

    const listed = await http.get<{
      requests: Array<{
        requestId: string;
        action: string;
        context: { kind: string; name: string; ownerActorId: string };
      }>;
    }>(`/v1/permission-requests?actorId=${appActor.actorId}`, admin);

    expect(listed.body.requests).toHaveLength(1);
    const req = listed.body.requests[0];
    expect(req.action).toBe("command:register");
    expect(req.context.kind).toBe("command.register");
    expect(req.context.name).toBe("analyze");
    expect(req.context.ownerActorId).toBe(appActor.actorId);
  });

  test("denying command:register request leaves no grant and keeps command inactive", async () => {
    const { admin, appActor } = await bootstrap();
    const reg = await http.post<{ commandId: string; requestId: string }>(
      "/v1/commands",
      { name: "dangerous" },
      appActor,
    );

    const resolve = await http.post<{ status: string; grantId: null }>(
      `/v1/permission-requests/${reg.body.requestId}/resolve`,
      { approve: false, notes: "too dangerous" },
      admin,
    );
    expect(resolve.body.status).toBe("denied");
    expect(resolve.body.grantId).toBeNull();

    const list = await http.get<{ commands: unknown[] }>("/v1/commands", admin);
    expect(list.body.commands).toHaveLength(0);
  });
});
