import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startServer, type RunningServer } from "../../../src/server-runtime.js";
import { defaultServerConfig } from "../../../src/config.js";
import type { MlPrincipal } from "../lib/message-layer";

// Integration smoke test for the nextjs lib/message-layer.ts helpers.
// It boots a real message-layer server on a random port, points the env at
// it, and then dynamically imports the client module so its env resolves to
// the test server. Every helper that the Next.js app UI depends on is
// exercised end-to-end over the wire.

let server: RunningServer;

beforeAll(async () => {
  server = await startServer({
    port: 0,
    logger: () => {},
    config: { ...defaultServerConfig(process.env), plugins: [], port: 0 },
  });
  process.env.MESSAGE_LAYER_BASE_URL = server.address;
  process.env.DEFAULT_ORG_NAME = `nextjs-smoke-${Date.now()}`;
});

afterAll(async () => {
  await server?.close();
});

describe("nextjs lib/message-layer helpers", () => {
  test("create org → actor → channel → post → list → redact → members → cursor", async () => {
    const ml = await import("../lib/message-layer");

    // Manually bootstrap an org + admin actor using raw HTTP (the helpers
    // assume a Better Auth session flow; here we stub the principal).
    const orgRes = await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "NextjsTestOrg" }),
    });
    const { orgId } = (await orgRes.json()) as { orgId: string };
    const actorRes = await fetch(`${server.address}/v1/actors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId, actorType: "human", displayName: "admin" }),
    });
    const { actorId } = (await actorRes.json()) as { actorId: string };

    const principal: MlPrincipal = {
      actorId,
      orgId,
      scopes: ["channel:create", "thread:create", "message:append", "grant:create", "channel:admin"],
      provider: "nextjs-test",
    };

    // channel create + list
    const channelId = await ml.createChannel(principal, "general");
    const channels = await ml.listChannels(principal);
    expect(channels.map((c) => c.id)).toContain(channelId);

    // post a text + artifact message
    await ml.appendMessage(principal, {
      streamId: channelId,
      streamType: "channel",
      parts: [
        { type: "text", payload: { text: "hello from nextjs helper" } },
        { type: "artifact", payload: { attachmentId: "fake-att-1", name: "logo.png" } },
      ],
    });

    const messages = await ml.listMessages(principal, channelId, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toHaveLength(2);
    const messageId = messages[0].id;

    // add an additional actor + membership management
    const otherActorRes = await fetch(`${server.address}/v1/actors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId, actorType: "human", displayName: "other" }),
    });
    const { actorId: otherActorId } = (await otherActorRes.json()) as { actorId: string };
    await ml.addChannelMember(principal, channelId, otherActorId);
    const members = await ml.listChannelMembers(principal, channelId);
    expect(members.map((m) => m.actorId)).toEqual(expect.arrayContaining([actorId, otherActorId]));
    await ml.removeChannelMember(principal, channelId, otherActorId);
    const after = await ml.listChannelMembers(principal, channelId);
    expect(after.map((m) => m.actorId)).not.toContain(otherActorId);

    // thread creation
    const threadId = await ml.createThread(principal, channelId, messageId);
    const threads = await ml.listThreads(principal, channelId);
    expect(threads.map((t) => t.id)).toContain(threadId);

    // redact
    await ml.redactMessage(principal, messageId, "test-redact");
    const afterRedact = await ml.listMessages(principal, channelId, 0);
    expect(afterRedact[0].redacted).toBe(true);
    expect(afterRedact[0].parts).toEqual([]);

    // permission requests end-to-end through helpers
    const requesterActorRes = await fetch(`${server.address}/v1/actors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId, actorType: "agent", displayName: "pi" }),
    });
    const { actorId: requesterId } = (await requesterActorRes.json()) as { actorId: string };
    const requesterPrincipal: MlPrincipal = {
      actorId: requesterId,
      orgId,
      scopes: [],
      provider: "nextjs-test-agent",
    };
    // Grant agent a base grant first so subsequent "grantAgentCapability" helper has something to revoke
    await ml.grantAgentCapability({
      orgId,
      grantorActorId: actorId,
      agentActorId: requesterId,
      resourceType: "channel",
      resourceId: channelId,
      capability: "message:append",
    });
    const grants = await ml.listPermissionRequests(principal);
    expect(Array.isArray(grants)).toBe(true);

    // listActors + listMembers helpers
    const actors = await ml.listActors(principal);
    expect(actors.map((a) => a.actorId)).toEqual(expect.arrayContaining([actorId, otherActorId, requesterId]));
    const orgMembers = await ml.listMembers(principal);
    expect(orgMembers.length).toBeGreaterThanOrEqual(3);

    // createAgentActor helper
    const newAgentId = await ml.createAgentActor(orgId, "second-bot");
    expect(newAgentId).toMatch(/^[0-9a-f]{32}$/);

    void requesterPrincipal; // exercised above via grantAgentCapability; silence unused warning
  });

  test("admin UI helpers: approval modes + revoke-grants + audit filter", async () => {
    const ml = await import("../lib/message-layer");

    // Fresh org so the audit chain is uncontaminated.
    const orgRes = await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "NextjsAdminTestOrg" }),
    });
    const { orgId } = (await orgRes.json()) as { orgId: string };
    const adminRes = await fetch(`${server.address}/v1/actors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId, actorType: "human", displayName: "admin" }),
    });
    const { actorId: adminActorId } = (await adminRes.json()) as { actorId: string };
    const admin: MlPrincipal = {
      actorId: adminActorId,
      orgId,
      scopes: ["channel:create", "thread:create", "message:append", "grant:create", "audit:read"],
      provider: "nextjs-test",
    };
    const botRes = await fetch(`${server.address}/v1/actors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId, actorType: "agent", displayName: "bot" }),
    });
    const { actorId: botActorId } = (await botRes.json()) as { actorId: string };
    const bot: MlPrincipal = { actorId: botActorId, orgId, scopes: [], provider: "nextjs-test-agent" };
    const channelId = await ml.createChannel(admin, "room");

    // Agent tries to post, autoRequestOnDeny opens a contextful request.
    const autoDeny = await fetch(`${server.address}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-principal": JSON.stringify(bot),
      },
      body: JSON.stringify({
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "from the bot" } }],
        idempotencyKey: "admin-smoke-1",
        autoRequestOnDeny: true,
      }),
    });
    const autoBody = (await autoDeny.json()) as { denied: boolean; requestId: string };
    expect(autoBody.denied).toBe(true);

    // Surface the context through the helper — this is what the UI renders.
    const open = await ml.listPermissionRequests(admin);
    const row = open.find((r) => r.requestId === autoBody.requestId);
    expect(row).toBeDefined();
    expect((row!.context as { kind?: string }).kind).toBe("message.append");

    // Approve with maxUses: 1 — the one-shot path.
    await ml.resolvePermissionRequest(admin, autoBody.requestId, true, { maxUses: 1 });

    // First retry succeeds, second opens a fresh request.
    const first = await fetch(`${server.address}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-principal": JSON.stringify(bot) },
      body: JSON.stringify({
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "first post" } }],
        idempotencyKey: "admin-smoke-2",
      }),
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${server.address}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-principal": JSON.stringify(bot) },
      body: JSON.stringify({
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "second post" } }],
        idempotencyKey: "admin-smoke-3",
      }),
    });
    expect(second.status).toBe(403);

    // Issue a long-lived grant so there's something to revoke, then "kick".
    await ml.grantAgentCapability({
      orgId,
      grantorActorId: adminActorId,
      agentActorId: botActorId,
      resourceType: "channel",
      resourceId: channelId,
      capability: "message:append",
    });
    const kicked = await ml.revokeAllGrantsForActor(admin, botActorId, "smoke-kick");
    expect(kicked.revokedGrantIds.length).toBeGreaterThanOrEqual(1);

    // Audit filter returns only rows involving the bot.
    const botRows = await ml.fetchAuditRows(admin, { actorId: botActorId });
    const types = botRows.map((r) => r.eventType);
    expect(types).toContain("message.appended");
    expect(types).toContain("grant.revoked");
    expect(types).not.toContain("org.created");
  });
});
