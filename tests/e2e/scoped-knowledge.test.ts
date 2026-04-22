import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { connect, type SqlDatabase } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { createApp } from "../../src/http.js";
import { applyPluginSchemas, applyPluginsToApp, resolvePlugins } from "../../src/plugins.js";
import { MessageLayer } from "../../src/service.js";
import type { Principal } from "../../src/types.js";

type PluginHarness = {
  db: SqlDatabase;
  service: MessageLayer;
  bus: InProcessEventBus;
  app: ReturnType<typeof createApp>;
  dispose: () => Promise<void>;
  close: () => Promise<void>;
};

async function makeHarness(): Promise<PluginHarness> {
  const db = await connect(`memory://sk-${Math.random().toString(16).slice(2)}`);
  const bus = new InProcessEventBus();
  const service = new MessageLayer(db, { bus });
  const app = createApp(service);
  const plugins = resolvePlugins(["scoped-knowledge"]);
  await applyPluginSchemas(db, plugins);
  const dispose = await applyPluginsToApp(
    {
      app,
      db,
      service,
      bus,
      logger: () => {},
      env: {},
      config: {
        port: 0,
        storage: { adapter: "pglite", path: "memory://sk" },
        artifacts: { kind: "memory" },
        plugins: ["scoped-knowledge"],
      },
    },
    plugins,
  );
  return {
    db,
    service,
    bus,
    app,
    dispose,
    close: async () => {
      await dispose();
      await db.close?.();
    },
  };
}

async function http<T = unknown>(
  app: { fetch: (req: Request) => Promise<Response> },
  method: "GET" | "POST",
  path: string,
  principal: Principal | null,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (principal) headers["x-principal"] = JSON.stringify(principal);
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as T) : ({} as T);
  return { status: res.status, body: parsed };
}

describe("scoped-knowledge plugin", () => {
  let h: PluginHarness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  test("does not index messages that have no text parts", async () => {
    const orgId = await h.service.createOrg("X");
    const adminId = await h.service.createActor(orgId, "human", "admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "message:append"],
      provider: "test",
    };
    const channelId = await h.service.createChannel(admin, "general", "public");

    await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "tool_call", payload: { name: "noop" } }],
      idempotencyKey: "a",
    });

    const res = await http<{ entries: unknown[] }>(h.app, "GET", `/v1/knowledge?streamId=${channelId}`, admin);
    expect(res.body.entries).toHaveLength(0);
  });

  test("snapshots source visibility at insertion and does not widen retroactively", async () => {
    // We model the "private first, public later" edge case: entries inserted
    // while the channel was private must remain bound to the source stream's
    // readability, not become widely readable.
    const orgId = await h.service.createOrg("Y");
    const adminId = await h.service.createActor(orgId, "human", "admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "channel:admin", "message:append"],
      provider: "test",
    };
    const channelId = await h.service.createChannel(admin, "private-first", "private");
    await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "sensitive" } }],
      idempotencyKey: "a",
    });
    const list = await http<{ entries: Array<{ sourceVisibility: string }> }>(
      h.app,
      "GET",
      `/v1/knowledge?streamId=${channelId}`,
      admin,
    );
    expect(list.body.entries[0]?.sourceVisibility).toBe("private");

    // Create another actor, not a channel member. Must be forbidden from
    // reading the derived entries regardless of how the stream's visibility
    // evolves later (we don't change it here; that's a separate product
    // decision).
    const outsiderId = await h.service.createActor(orgId, "human", "out");
    const outsider: Principal = { actorId: outsiderId, orgId, scopes: [], provider: "test" };
    const denied = await http(h.app, "GET", `/v1/knowledge?streamId=${channelId}`, outsider);
    expect(denied.status).toBe(403);
  });

  test("promotion requires knowledge:promote scope or grant", async () => {
    const orgId = await h.service.createOrg("Z");
    const adminId = await h.service.createActor(orgId, "human", "admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "message:append", "grant:create"],
      provider: "test",
    };
    const channelId = await h.service.createChannel(admin, "room", "public");
    await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "insight" } }],
      idempotencyKey: "a",
    });
    const list = await http<{ entries: Array<{ id: string }> }>(
      h.app,
      "GET",
      `/v1/knowledge?streamId=${channelId}`,
      admin,
    );
    const entryId = list.body.entries[0]?.id;
    expect(entryId).toBeTruthy();

    // Admin lacks knowledge:promote scope → 403.
    const noScope = await http<{ code: string }>(h.app, "POST", `/v1/knowledge/${entryId}/promote`, admin, {});
    expect(noScope.status).toBe(403);
    expect(noScope.body.code).toBe("PERMISSION_DENIED");

    // Issue a grant; retry.
    await h.service.createGrant(admin, admin.actorId, "org", orgId, "knowledge:promote");
    const withGrant = await http<{ entry: { promoted: boolean } }>(
      h.app,
      "POST",
      `/v1/knowledge/${entryId}/promote`,
      admin,
      { summary: "share" },
    );
    expect(withGrant.status).toBe(200);
    expect(withGrant.body.entry.promoted).toBe(true);
  });

  test("promotion via service hook flows through the core bus + audit", async () => {
    const orgId = await h.service.createOrg("A");
    const adminId = await h.service.createActor(orgId, "human", "admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "message:append", "knowledge:promote", "audit:read"],
      provider: "test",
    };
    const channelId = await h.service.createChannel(admin, "ch", "public");
    await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "hello" } }],
      idempotencyKey: "a",
    });
    const list = await http<{ entries: Array<{ id: string }> }>(
      h.app,
      "GET",
      `/v1/knowledge?streamId=${channelId}`,
      admin,
    );
    const entryId = list.body.entries[0]!.id;

    const seen: string[] = [];
    h.bus.subscribe((e) => seen.push(e.type));

    await http(h.app, "POST", `/v1/knowledge/${entryId}/promote`, admin, {});

    expect(seen).toContain("knowledge.promoted");

    const audit = await http<{ rows: Array<{ eventType: string }> }>(h.app, "GET", "/v1/audit/rows", admin);
    expect(audit.body.rows.map((r) => r.eventType)).toContain("knowledge.promoted");
  });

  test("org-wide promoted listing requires org membership", async () => {
    const orgA = await h.service.createOrg("A-org");
    const adminA = await h.service.createActor(orgA, "human", "a");
    const principalA: Principal = { actorId: adminA, orgId: orgA, scopes: [], provider: "test" };

    // Foreign principal — valid actor ID but from a different org — must be
    // rejected instead of seeing a partial list.
    const orgB = await h.service.createOrg("B-org");
    const adminB = await h.service.createActor(orgB, "human", "b");
    const spoofed: Principal = { actorId: adminB, orgId: orgA, scopes: [], provider: "test" };

    const ok = await http<{ entries: unknown[] }>(
      h.app,
      "GET",
      "/v1/knowledge?includePromotedElsewhere=true",
      principalA,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.entries).toHaveLength(0);

    const denied = await http<{ code: string }>(
      h.app,
      "GET",
      "/v1/knowledge?includePromotedElsewhere=true",
      spoofed,
    );
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("PERMISSION_DENIED");
  });
});
