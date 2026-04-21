/**
 * E2E tests for the `ui` message part type over real HTTP.
 *
 * Boots a full message-layer server (PGlite, no plugins needed) and exercises
 * the entire request path: POST /v1/messages with `ui` parts, GET messages,
 * SSE stream subscribe, privacy enforcement.
 *
 * No mocks, no stubs.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startServer, type RunningServer } from "../../src/server-runtime.js";
import type { Principal } from "../../src/types.js";

let server: RunningServer;

beforeAll(async () => {
  server = await startServer({
    port: 0,
    logger: () => {},
    config: {
      port: 0,
      websocket: false,
      storage: {
        adapter: "pglite",
        path: `memory://genui-e2e-${Math.random().toString(16).slice(2)}`,
      },
      artifacts: { kind: "memory" },
      plugins: [],
    },
  });
});

afterAll(async () => {
  await server?.close();
});

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function api<T>(
  method: "GET" | "POST",
  path: string,
  principal: Principal | null,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (principal) headers["x-principal"] = JSON.stringify(principal);
  const res = await fetch(`${server.address}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as T };
}

// ── sample spec ───────────────────────────────────────────────────────────────

function dashboardSpec() {
  return {
    root: "card-1",
    elements: {
      "card-1": {
        type: "Card",
        props: { title: "Sprint Summary" },
        children: ["stack-1"],
      },
      "stack-1": {
        type: "Stack",
        props: { direction: "horizontal", gap: 4 },
        children: ["metric-1", "metric-2", "badge-1"],
      },
      "metric-1": {
        type: "Metric",
        props: { label: "PRs merged", value: "17" },
        children: [],
      },
      "metric-2": {
        type: "Metric",
        props: { label: "Issues closed", value: "23" },
        children: [],
      },
      "badge-1": {
        type: "Badge",
        props: { text: "On track", variant: "success" },
        children: [],
      },
    },
  };
}

// ── bootstrap helper ──────────────────────────────────────────────────────────

async function bootstrap() {
  const { body: org } = await api<{ orgId: string }>("POST", "/v1/orgs", null, {
    name: `genui-org-${Date.now()}`,
  });
  const { body: agentActor } = await api<{ actorId: string }>("POST", "/v1/actors", null, {
    orgId: org.orgId,
    actorType: "agent",
    displayName: "ui-bot",
  });
  const { body: humanActor } = await api<{ actorId: string }>("POST", "/v1/actors", null, {
    orgId: org.orgId,
    actorType: "human",
    displayName: "Alice",
  });
  const { body: outsiderActor } = await api<{ actorId: string }>("POST", "/v1/actors", null, {
    orgId: org.orgId,
    actorType: "human",
    displayName: "outsider",
  });

  const admin: Principal = {
    actorId: humanActor.actorId,
    orgId: org.orgId,
    scopes: ["channel:create", "message:append", "grant:create", "channel:admin", "audit:read"],
    provider: "e2e-test",
  };
  const agent: Principal = {
    actorId: agentActor.actorId,
    orgId: org.orgId,
    scopes: [],
    provider: "e2e-test",
  };
  const outsider: Principal = {
    actorId: outsiderActor.actorId,
    orgId: org.orgId,
    scopes: [],
    provider: "e2e-test",
  };

  const { body: ch } = await api<{ channelId: string }>("POST", "/v1/channels", admin, {
    name: "work",
    visibility: "private",
  });

  // Add agent as a channel member (required for private channel access)
  await api("POST", `/v1/channels/${ch.channelId}/members`, admin, { actorId: agent.actorId });

  // Grant agent message:append on the channel
  await api("POST", "/v1/grants", admin, {
    actorId: agent.actorId,
    resourceType: "channel",
    resourceId: ch.channelId,
    capability: "message:append",
  });

  return { orgId: org.orgId, admin, agent, outsider, channelId: ch.channelId };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("HTTP / ui message parts", () => {
  test("agent can post a ui part and admin can retrieve it", async () => {
    const { admin, agent, channelId } = await bootstrap();
    const spec = dashboardSpec();

    const { status: postStatus, body: postBody } = await api<{
      messageId: string;
      streamSeq: number;
    }>("POST", "/v1/messages", agent, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "ui", payload: { catalog: "shadcn", spec } }],
      idempotencyKey: `ui-http-${Date.now()}`,
    });
    expect(postStatus).toBe(200);
    expect(typeof postBody.messageId).toBe("string");

    const { body: msgs } = await api<{
      messages: Array<{
        id: string;
        parts: Array<{ type: string; payload: Record<string, unknown> }>;
      }>;
    }>("GET", `/v1/streams/${channelId}/messages`, admin);

    expect(msgs.messages).toHaveLength(1);
    const [msg] = msgs.messages;
    expect(msg.parts[0].type).toBe("ui");
    expect(msg.parts[0].payload.catalog).toBe("shadcn");
    const storedSpec = msg.parts[0].payload.spec as typeof spec;
    expect(storedSpec.root).toBe("card-1");
    expect(Object.keys(storedSpec.elements)).toHaveLength(5);
  });

  test("ui part is returned in stream subscribe (SSE replay)", async () => {
    const { admin, agent, channelId } = await bootstrap();

    await api("POST", "/v1/messages", agent, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "ui", payload: { catalog: "shadcn", spec: dashboardSpec() } }],
      idempotencyKey: `ui-sse-${Date.now()}`,
    });

    const { body: events } = await api<{
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    }>("GET", `/v1/streams/${channelId}/subscribe`, admin);

    const appendedEvent = events.events.find((e) => e.type === "message.appended");
    expect(appendedEvent).toBeDefined();
  });

  test("ui + text parts coexist in one message over HTTP", async () => {
    const { admin, agent, channelId } = await bootstrap();

    await api("POST", "/v1/messages", agent, {
      streamId: channelId,
      streamType: "channel",
      parts: [
        { type: "text", payload: { text: "Here is your weekly report:" } },
        { type: "ui", payload: { catalog: "shadcn", spec: dashboardSpec() } },
      ],
      idempotencyKey: `ui-combo-http-${Date.now()}`,
    });

    const { body: msgs } = await api<{
      messages: Array<{ parts: Array<{ type: string }> }>;
    }>("GET", `/v1/streams/${channelId}/messages`, admin);

    expect(msgs.messages[0].parts).toHaveLength(2);
    expect(msgs.messages[0].parts[0].type).toBe("text");
    expect(msgs.messages[0].parts[1].type).toBe("ui");
  });

  test("outsider cannot retrieve ui messages from private channel", async () => {
    const { agent, outsider, channelId } = await bootstrap();

    await api("POST", "/v1/messages", agent, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "ui", payload: { catalog: "shadcn", spec: dashboardSpec() } }],
      idempotencyKey: `ui-priv-http-${Date.now()}`,
    });

    const { status } = await api("GET", `/v1/streams/${channelId}/messages`, outsider);
    expect(status).toBe(403);
  });

  test("ui part audit trail contains the message event", async () => {
    const { admin, agent, channelId } = await bootstrap();

    const { body: posted } = await api<{ messageId: string }>("POST", "/v1/messages", agent, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "ui", payload: { catalog: "shadcn", spec: dashboardSpec() } }],
      idempotencyKey: `ui-audit-http-${Date.now()}`,
    });
    expect(typeof posted.messageId).toBe("string");

    const { body: auditBody } = await api<{
      rows: Array<{ eventType: string; payload: Record<string, unknown> }>;
    }>("GET", "/v1/audit/rows", admin);

    // Filter to only this org's message.appended rows for the specific message
    const appendedRows = auditBody.rows.filter(
      (r) => r.eventType === "message.appended" &&
             (r.payload as { messageId?: string }).messageId === posted.messageId,
    );
    expect(appendedRows.length).toBeGreaterThan(0);
    expect((appendedRows[0].payload as { partCount: number }).partCount).toBe(1);
  });

  test("knowledge plugin indexes ui messages (scoped-knowledge)", async () => {
    const srv = await startServer({
      port: 0,
      logger: () => {},
      config: {
        port: 0,
        websocket: false,
        storage: {
          adapter: "pglite",
          path: `memory://genui-sk-${Math.random().toString(16).slice(2)}`,
        },
        artifacts: { kind: "memory" },
        plugins: ["scoped-knowledge"],
      },
    });

    // All calls go to `srv`, not the outer server, so use a local fetch helper
    const skFetch = async <T>(method: "GET" | "POST", path: string, principal: Principal | null, body?: unknown): Promise<{ status: number; body: T }> => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (principal) headers["x-principal"] = JSON.stringify(principal);
      const res = await fetch(`${srv.address}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      return { status: res.status, body: (await res.json()) as T };
    };

    try {
      const { body: org } = await skFetch<{ orgId: string }>("POST", "/v1/orgs", null, { name: "sk-org" });
      const { body: act } = await skFetch<{ actorId: string }>("POST", "/v1/actors", null, {
        orgId: org.orgId,
        actorType: "human",
        displayName: "admin",
      });
      const p: Principal = {
        actorId: act.actorId,
        orgId: org.orgId,
        scopes: ["channel:create", "message:append", "knowledge:promote"],
        provider: "e2e-test",
      };
      const { body: ch } = await skFetch<{ channelId: string }>("POST", "/v1/channels", p, {
        name: "sk-ch",
        visibility: "private",
      });

      // Post a message with BOTH a text summary and a ui part.
      // scoped-knowledge indexes the text summary; the ui part is stored but
      // not extracted (the plugin only operates on text parts by design).
      await skFetch("POST", "/v1/messages", p, {
        streamId: ch.channelId,
        streamType: "channel",
        parts: [
          { type: "text", payload: { text: "Sprint 42 summary" } },
          { type: "ui", payload: { catalog: "shadcn", spec: dashboardSpec() } },
        ],
        idempotencyKey: "sk-ui-1",
      });

      const { body: knowledge } = await skFetch<{
        entries: Array<{ id: string; promoted: boolean; text: string }>;
      }>("GET", `/v1/knowledge?streamId=${ch.channelId}`, p);

      // scoped-knowledge indexes the text part; the ui part is ignored (by design)
      expect(knowledge.entries.length).toBeGreaterThanOrEqual(1);
      expect(knowledge.entries.some((e) => e.text.includes("Sprint 42"))).toBe(true);
    } finally {
      await srv.close();
    }
  });
});
