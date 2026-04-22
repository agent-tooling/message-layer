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
  const db = await connect(`memory://memory-${Math.random().toString(16).slice(2)}`);
  const bus = new InProcessEventBus();
  const service = new MessageLayer(db, { bus });
  const app = createApp(service);
  const plugins = resolvePlugins(["memory"]);
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
        storage: { adapter: "pglite", path: "memory://memory" },
        artifacts: { kind: "memory" },
        plugins: ["memory"],
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

/**
 * Memory ingestion runs inside a `bus.subscribe` listener that fires after
 * the originating service call resolves (the in-process bus is fire-and-
 * forget — see `src/event-bus.ts`). Tests must therefore wait briefly for
 * the indexer to catch up. This helper polls real HTTP fetches; nothing is
 * mocked.
 */
async function eventually<T>(
  fetcher: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 1000;
  const intervalMs = options.intervalMs ?? 25;
  const start = Date.now();
  let last = await fetcher();
  while (!predicate(last)) {
    if (Date.now() - start > timeoutMs) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fetcher();
  }
  return last;
}

type MemoryUnitDto = {
  id: string;
  canonicalText: string;
  summary: string;
  keywords: string[];
  sourceVisibility: "private" | "public";
  sourceMessageIds: string[];
  promoted: boolean;
  promotionSummary: string | null;
};

async function adminFor(
  service: MessageLayer,
  orgName: string,
  scopes: string[] = ["channel:create", "channel:admin", "message:append", "grant:create"],
): Promise<{ orgId: string; admin: Principal }> {
  const orgId = await service.createOrg(orgName);
  const adminId = await service.createActor(orgId, "human", "admin");
  return {
    orgId,
    admin: { actorId: adminId, orgId, scopes, provider: "test" },
  };
}

describe("memory plugin", () => {
  let h: PluginHarness;

  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  test("ignores messages without text parts and short filler", async () => {
    const { admin, orgId } = await adminFor(h.service, "Filler");
    void orgId;
    const channelId = await h.service.createChannel(admin, "general", "public");

    await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "tool_call", payload: { name: "noop" } }],
      idempotencyKey: "a",
    });
    await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "ok" } }],
      idempotencyKey: "b",
    });

    // Wait briefly so the bus listener has had a chance to (correctly)
    // produce zero units; otherwise we couldn't tell "ignored" from
    // "not yet processed".
    await new Promise((r) => setTimeout(r, 50));
    const res = await http<{ units: unknown[] }>(h.app, "GET", `/v1/memory?streamId=${channelId}`, admin);
    expect(res.body.units).toHaveLength(0);
  });

  test("dedupes identical text into one memory unit with multiple sources", async () => {
    const { admin } = await adminFor(h.service, "Dedupe");
    const channelId = await h.service.createChannel(admin, "team", "public");

    const a = await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "we ship on Friday" } }],
      idempotencyKey: "a",
    });
    const b = await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "we ship on Friday" } }],
      idempotencyKey: "b",
    });
    expect("messageId" in a && "messageId" in b).toBe(true);

    const res = await eventually(
      () => http<{ units: MemoryUnitDto[] }>(h.app, "GET", `/v1/memory?streamId=${channelId}`, admin),
      (r) => r.body.units.length === 1 && r.body.units[0].sourceMessageIds.length === 2,
    );
    expect(res.body.units.length).toBe(1);
    expect(res.body.units[0].sourceMessageIds.length).toBe(2);
  });

  test("snapshots source visibility and never widens retroactively", async () => {
    const { orgId, admin } = await adminFor(h.service, "Privacy");
    const channelId = await h.service.createChannel(admin, "private-first", "private");
    await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "highly sensitive launch plan" } }],
      idempotencyKey: "a",
    });
    const list = await eventually(
      () => http<{ units: MemoryUnitDto[] }>(h.app, "GET", `/v1/memory?streamId=${channelId}`, admin),
      (r) => r.body.units.length > 0,
    );
    expect(list.body.units[0]?.sourceVisibility).toBe("private");

    const outsiderId = await h.service.createActor(orgId, "human", "out");
    const outsider: Principal = { actorId: outsiderId, orgId, scopes: [], provider: "test" };
    const denied = await http(h.app, "GET", `/v1/memory?streamId=${channelId}`, outsider);
    expect(denied.status).toBe(403);
  });

  test("promotion requires memory:promote scope or grant", async () => {
    const { orgId, admin } = await adminFor(h.service, "Promote");
    const channelId = await h.service.createChannel(admin, "room", "public");
    await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "promotion target sentence" } }],
      idempotencyKey: "a",
    });
    const list = await eventually(
      () => http<{ units: MemoryUnitDto[] }>(h.app, "GET", `/v1/memory?streamId=${channelId}`, admin),
      (r) => r.body.units.length > 0,
    );
    const memoryId = list.body.units[0]?.id;
    expect(memoryId).toBeTruthy();

    const noScope = await http<{ code: string }>(h.app, "POST", `/v1/memory/${memoryId}/promote`, admin, {});
    expect(noScope.status).toBe(403);
    expect(noScope.body.code).toBe("PERMISSION_DENIED");

    await h.service.createGrant(admin, admin.actorId, "org", orgId, "memory:promote");
    const withGrant = await http<{ unit: { promoted: boolean } }>(
      h.app,
      "POST",
      `/v1/memory/${memoryId}/promote`,
      admin,
      { summary: "share" },
    );
    expect(withGrant.status).toBe(200);
    expect(withGrant.body.unit.promoted).toBe(true);
  });

  test("promotion flows through the core bus and audit log", async () => {
    const { admin } = await adminFor(h.service, "Audit", [
      "channel:create",
      "message:append",
      "memory:promote",
      "audit:read",
    ]);
    const channelId = await h.service.createChannel(admin, "ch", "public");
    await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "candidate for promotion" } }],
      idempotencyKey: "a",
    });
    const list = await eventually(
      () => http<{ units: MemoryUnitDto[] }>(h.app, "GET", `/v1/memory?streamId=${channelId}`, admin),
      (r) => r.body.units.length > 0,
    );
    const memoryId = list.body.units[0]!.id;

    const seen: string[] = [];
    h.bus.subscribe((e) => seen.push(e.type));

    await http(h.app, "POST", `/v1/memory/${memoryId}/promote`, admin, {});

    expect(seen).toContain("memory.promoted");

    const audit = await http<{ rows: Array<{ eventType: string }> }>(h.app, "GET", "/v1/audit/rows", admin);
    expect(audit.body.rows.map((r) => r.eventType)).toContain("memory.promoted");
  });

  test("redacting the only source message deletes its memory unit", async () => {
    const { admin } = await adminFor(h.service, "Redact", [
      "channel:create",
      "message:append",
    ]);
    const channelId = await h.service.createChannel(admin, "redact", "public");
    const append = await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "redactable insight here" } }],
      idempotencyKey: "a",
    });
    if (!("messageId" in append)) throw new Error("expected success");

    const before = await eventually(
      () => http<{ units: MemoryUnitDto[] }>(h.app, "GET", `/v1/memory?streamId=${channelId}`, admin),
      (r) => r.body.units.length === 1,
    );
    expect(before.body.units.length).toBe(1);

    await h.service.redactMessage(admin, append.messageId);

    const after = await eventually(
      () => http<{ units: MemoryUnitDto[] }>(h.app, "GET", `/v1/memory?streamId=${channelId}`, admin),
      (r) => r.body.units.length === 0,
    );
    expect(after.body.units.length).toBe(0);
  });

  test("redaction of one of multiple source messages keeps the unit (link removed)", async () => {
    const { admin } = await adminFor(h.service, "RedactMulti");
    const channelId = await h.service.createChannel(admin, "rm", "public");
    const a = await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "shared identical insight" } }],
      idempotencyKey: "a",
    });
    await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "shared identical insight" } }],
      idempotencyKey: "b",
    });
    if (!("messageId" in a)) throw new Error("expected success");

    // Wait until both messages have been ingested into a single deduped unit.
    await eventually(
      () => http<{ units: MemoryUnitDto[] }>(h.app, "GET", `/v1/memory?streamId=${channelId}`, admin),
      (r) => r.body.units.length === 1 && r.body.units[0].sourceMessageIds.length === 2,
    );

    await h.service.redactMessage(admin, a.messageId);

    const after = await eventually(
      () => http<{ units: MemoryUnitDto[] }>(h.app, "GET", `/v1/memory?streamId=${channelId}`, admin),
      (r) =>
        r.body.units.length === 1 &&
        !r.body.units[0].sourceMessageIds.includes(a.messageId),
    );
    expect(after.body.units.length).toBe(1);
    expect(after.body.units[0].sourceMessageIds).not.toContain(a.messageId);
  });

  test("memory search respects stream visibility and ranks lexical hits", async () => {
    const { admin, orgId } = await adminFor(h.service, "Search", [
      "channel:create",
      "channel:admin",
      "message:append",
    ]);
    const publicCh = await h.service.createChannel(admin, "public-ch", "public");
    const privateCh = await h.service.createChannel(admin, "private-ch", "private");
    await h.service.appendMessage(admin, {
      streamId: publicCh,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "deployment cookbook for Friday rollout" } }],
      idempotencyKey: "p1",
    });
    await h.service.appendMessage(admin, {
      streamId: privateCh,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "private rollout schedule with secrets" } }],
      idempotencyKey: "p2",
    });

    const adminHits = await eventually(
      () =>
        http<{ hits: Array<{ unit: MemoryUnitDto }> }>(
          h.app,
          "GET",
          `/v1/memory/search?q=${encodeURIComponent("rollout")}`,
          admin,
        ),
      (r) => r.body.hits.length === 2,
    );
    expect(adminHits.status).toBe(200);
    expect(adminHits.body.hits.length).toBe(2);

    // Outsider only sees the public channel entry.
    const outsiderId = await h.service.createActor(orgId, "human", "outsider");
    const outsider: Principal = { actorId: outsiderId, orgId, scopes: [], provider: "test" };
    const outsiderHits = await http<{ hits: Array<{ unit: MemoryUnitDto }> }>(
      h.app,
      "GET",
      `/v1/memory/search?q=${encodeURIComponent("rollout")}`,
      outsider,
    );
    expect(outsiderHits.status).toBe(200);
    expect(outsiderHits.body.hits.length).toBe(1);
    expect(outsiderHits.body.hits[0].unit.sourceStreamId).toBe(publicCh);
  });
});
