import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { connect, type SqlDatabase } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { createApp } from "../../src/http.js";
import {
  applyPluginSchemas,
  applyPluginsToApp,
  resolvePlugins,
  type PluginSpec,
} from "../../src/plugins.js";
import { MessageLayer } from "../../src/service.js";
import type { Principal } from "../../src/types.js";

type SearchHarness = {
  db: SqlDatabase;
  service: MessageLayer;
  bus: InProcessEventBus;
  app: ReturnType<typeof createApp>;
  dispose: () => Promise<void>;
  close: () => Promise<void>;
};

async function makeHarness(plugins: PluginSpec[]): Promise<SearchHarness> {
  const db = await connect(`memory://search-${Math.random().toString(16).slice(2)}`);
  const bus = new InProcessEventBus();
  const service = new MessageLayer(db, { bus });
  const app = createApp(service);
  const resolved = resolvePlugins(plugins);
  await applyPluginSchemas(db, resolved);
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
        storage: { adapter: "pglite", path: "memory://search" },
        artifacts: { kind: "memory" },
        plugins,
      },
    },
    resolved,
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
 * Search and memory plugins are populated by `bus.subscribe` listeners that
 * run *after* the originating service-call resolves (the in-process bus is
 * fire-and-forget on purpose so a slow plugin never delays a write — see
 * `src/event-bus.ts`). Tests must therefore wait briefly for indexing.
 *
 * This helper polls the predicate until it returns truthy or the budget is
 * exhausted; it always uses real fetches against the real Hono app, never
 * mocks.
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

type SearchHit = {
  documentId: string;
  entityType: "actor" | "channel" | "thread" | "message" | "memory";
  entityId: string;
  score: number;
  title: string;
  snippet: string;
  highlights: string[];
  sourceStreamId: string | null;
  sourceVisibility: "private" | "public" | null;
  promoted: boolean;
  actorType: "human" | "agent" | "app" | null;
  metadata: Record<string, unknown>;
};

describe("search plugin (standalone)", () => {
  let h: SearchHarness;
  beforeEach(async () => {
    h = await makeHarness(["search"]);
  });
  afterEach(async () => {
    await h.close();
  });

  test("indexes actors (human, agent, app) and ranks them above message hits", async () => {
    const orgId = await h.service.createOrg("Acme");
    const adminId = await h.service.createActor(orgId, "human", "alice-admin");
    await h.service.createActor(orgId, "agent", "alice-bot");
    await h.service.createActor(orgId, "app", "alice-app");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "message:append"],
      provider: "test",
    };
    const channelId = await h.service.createChannel(admin, "alice-channel", "public");
    await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "alice asked about staging access" } }],
      idempotencyKey: "m1",
    });

    const res = await eventually(
      () => http<{ hits: SearchHit[] }>(h.app, "GET", `/v1/search?q=${encodeURIComponent("alice")}`, admin),
      (r) => {
        const types = new Set(r.body.hits.map((hit) => hit.entityType));
        return types.has("actor") && types.has("channel") && types.has("message");
      },
    );
    expect(res.status).toBe(200);
    const types = res.body.hits.map((h) => h.entityType);
    expect(types).toContain("actor");
    expect(types).toContain("channel");
    expect(types).toContain("message");
    // First hit should be one of the highly targeted entity types.
    expect(["actor", "channel"]).toContain(res.body.hits[0]?.entityType);
  });

  test("filters by entityTypes and actorType", async () => {
    const orgId = await h.service.createOrg("Filter");
    const adminId = await h.service.createActor(orgId, "human", "filter-admin");
    await h.service.createActor(orgId, "agent", "filter-bot");
    await h.service.createActor(orgId, "app", "filter-app");
    const admin: Principal = { actorId: adminId, orgId, scopes: ["channel:create"], provider: "test" };

    const onlyAgents = await http<{ hits: SearchHit[] }>(
      h.app,
      "GET",
      `/v1/search?q=${encodeURIComponent("filter")}&entityTypes=actor&actorType=agent`,
      admin,
    );
    expect(onlyAgents.status).toBe(200);
    expect(onlyAgents.body.hits.every((hit) => hit.entityType === "actor")).toBe(true);
    expect(onlyAgents.body.hits.every((hit) => hit.actorType === "agent")).toBe(true);
  });

  test("messages in private channels never leak to non-members", async () => {
    const orgId = await h.service.createOrg("Privacy");
    const adminId = await h.service.createActor(orgId, "human", "priv-admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "channel:admin", "message:append"],
      provider: "test",
    };
    const privateCh = await h.service.createChannel(admin, "priv", "private");
    await h.service.appendMessage(admin, {
      streamId: privateCh,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "secret confidential rollout details" } }],
      idempotencyKey: "p1",
    });

    const outsiderId = await h.service.createActor(orgId, "human", "outsider");
    const outsider: Principal = { actorId: outsiderId, orgId, scopes: [], provider: "test" };
    const res = await http<{ hits: SearchHit[] }>(
      h.app,
      "GET",
      `/v1/search?q=${encodeURIComponent("confidential")}`,
      outsider,
    );
    expect(res.status).toBe(200);
    expect(res.body.hits.find((h) => h.entityType === "message")).toBeUndefined();
  });

  test("threaded message search (privacy preserved on thread visibility)", async () => {
    const orgId = await h.service.createOrg("Thread");
    const adminId = await h.service.createActor(orgId, "human", "thread-admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: [
        "channel:create",
        "channel:admin",
        "thread:create",
        "message:append",
      ],
      provider: "test",
    };
    const channelId = await h.service.createChannel(admin, "thread-ch", "public");
    const parent = await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "parent message about quarterly review" } }],
      idempotencyKey: "p1",
    });
    if (!("messageId" in parent)) throw new Error("expected append success");
    const threadId = await h.service.createThread(admin, channelId, parent.messageId, "public");
    await h.service.appendMessage(admin, {
      streamId: threadId,
      streamType: "thread",
      parts: [{ type: "text", payload: { text: "thread reply about quarterly metrics dashboard" } }],
      idempotencyKey: "t1",
    });

    const res = await eventually(
      () =>
        http<{ hits: SearchHit[] }>(
          h.app,
          "GET",
          `/v1/search?q=${encodeURIComponent("dashboard")}&entityTypes=message`,
          admin,
        ),
      (r) => r.body.hits.some((h) => h.entityType === "message"),
    );
    expect(res.status).toBe(200);
    const hit = res.body.hits.find((h) => h.entityType === "message");
    expect(hit).toBeDefined();
    expect(hit?.sourceStreamId).toBe(threadId);
  });

  test("redacted messages disappear from search", async () => {
    const orgId = await h.service.createOrg("Redact");
    const adminId = await h.service.createActor(orgId, "human", "redact-admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "message:append"],
      provider: "test",
    };
    const ch = await h.service.createChannel(admin, "redact-ch", "public");
    const append = await h.service.appendMessage(admin, {
      streamId: ch,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "redactable distinctive marker" } }],
      idempotencyKey: "a",
    });
    if (!("messageId" in append)) throw new Error("expected append success");

    const before = await eventually(
      () =>
        http<{ hits: SearchHit[] }>(
          h.app,
          "GET",
          `/v1/search?q=${encodeURIComponent("distinctive")}&entityTypes=message`,
          admin,
        ),
      (r) => r.body.hits.length === 1,
    );
    expect(before.body.hits.length).toBe(1);

    await h.service.redactMessage(admin, append.messageId);

    const after = await eventually(
      () =>
        http<{ hits: SearchHit[] }>(
          h.app,
          "GET",
          `/v1/search?q=${encodeURIComponent("distinctive")}&entityTypes=message`,
          admin,
        ),
      (r) => r.body.hits.find((hit) => hit.entityType === "message") === undefined,
    );
    expect(after.body.hits.find((h) => h.entityType === "message")).toBeUndefined();
  });

  test("autosuggest returns actor / channel / thread labels only", async () => {
    const orgId = await h.service.createOrg("Suggest");
    const adminId = await h.service.createActor(orgId, "human", "suggest-admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "message:append"],
      provider: "test",
    };
    const ch = await h.service.createChannel(admin, "suggest-channel", "public");
    void ch;
    const res = await http<{ suggestions: Array<{ entityType: string; label: string }> }>(
      h.app,
      "GET",
      `/v1/search/suggest?q=${encodeURIComponent("suggest")}`,
      admin,
    );
    expect(res.status).toBe(200);
    for (const s of res.body.suggestions) {
      expect(["actor", "channel", "thread"]).toContain(s.entityType);
    }
  });
});

describe("search ↔ memory plugin composition", () => {
  let h: SearchHarness;
  beforeEach(async () => {
    h = await makeHarness(["memory", "search"]);
  });
  afterEach(async () => {
    await h.close();
  });

  test("memory units land in /v1/search results when both plugins are enabled", async () => {
    const orgId = await h.service.createOrg("Compose");
    const adminId = await h.service.createActor(orgId, "human", "compose-admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "message:append"],
      provider: "test",
    };
    const channelId = await h.service.createChannel(admin, "compose-ch", "public");
    await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "indexed-memory: distinctive composition phrase" } }],
      idempotencyKey: "a",
    });

    const res = await eventually(
      () =>
        http<{ hits: SearchHit[] }>(
          h.app,
          "GET",
          `/v1/search?q=${encodeURIComponent("distinctive")}`,
          admin,
        ),
      (r) => r.body.hits.some((h) => h.entityType === "memory"),
    );
    expect(res.status).toBe(200);
    const memHit = res.body.hits.find((h) => h.entityType === "memory");
    expect(memHit).toBeDefined();
    expect(memHit?.snippet).toContain("distinctive");
  });

  test("promoted memory is searchable by org members even without source-stream access", async () => {
    const orgId = await h.service.createOrg("PromoteSearch");
    const adminId = await h.service.createActor(orgId, "human", "promote-admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: [
        "channel:create",
        "channel:admin",
        "message:append",
        "memory:promote",
      ],
      provider: "test",
    };
    const privateCh = await h.service.createChannel(admin, "priv", "private");
    await h.service.appendMessage(admin, {
      streamId: privateCh,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "promotable findings from sales call" } }],
      idempotencyKey: "a",
    });

    type MemoryUnitDto = { id: string; canonicalText: string };
    const list = await http<{ units: MemoryUnitDto[] }>(h.app, "GET", `/v1/memory?streamId=${privateCh}`, admin);
    const memId = list.body.units[0].id;
    await http(h.app, "POST", `/v1/memory/${memId}/promote`, admin, { summary: "share" });

    const outsiderId = await h.service.createActor(orgId, "human", "outsider");
    const outsider: Principal = { actorId: outsiderId, orgId, scopes: [], provider: "test" };
    const res = await http<{ hits: SearchHit[] }>(
      h.app,
      "GET",
      `/v1/search?q=${encodeURIComponent("findings")}`,
      outsider,
    );
    expect(res.status).toBe(200);
    const memHit = res.body.hits.find((h) => h.entityType === "memory");
    expect(memHit).toBeDefined();
    expect(memHit?.promoted).toBe(true);
    // No private message hits leak.
    expect(res.body.hits.find((h) => h.entityType === "message")).toBeUndefined();
  });

  test("search works standalone when memory plugin is absent", async () => {
    await h.close();
    h = await makeHarness(["search"]);
    const orgId = await h.service.createOrg("Solo");
    const adminId = await h.service.createActor(orgId, "human", "solo-admin");
    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "message:append"],
      provider: "test",
    };
    const channelId = await h.service.createChannel(admin, "solo-ch", "public");
    await h.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "standalone search exercise" } }],
      idempotencyKey: "a",
    });
    const res = await eventually(
      () =>
        http<{ hits: SearchHit[] }>(
          h.app,
          "GET",
          `/v1/search?q=${encodeURIComponent("standalone")}`,
          admin,
        ),
      (r) => r.body.hits.some((h) => h.entityType === "message"),
    );
    expect(res.status).toBe(200);
    expect(res.body.hits.find((h) => h.entityType === "memory")).toBeUndefined();
    expect(res.body.hits.find((h) => h.entityType === "message")).toBeDefined();
  });
});
