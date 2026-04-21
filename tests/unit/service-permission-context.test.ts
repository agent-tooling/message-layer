import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOrg, createServiceHarness, principalFor } from "../helpers/harness.js";

/**
 * Permission-request context: the purpose-aware metadata that lets a human
 * see *what* the agent wants to do before deciding to approve it. Covered:
 *
 *   - appendMessage auto-preserves the stream, parts, and a preview of text
 *   - createPermissionRequest accepts an explicit context for actions the
 *     service doesn't open the request for (channel:create, etc.)
 *   - the context round-trips through listOpenPermissionRequests
 *   - the `permission_request.created` event carries the context for
 *     plugins (notifications, policy engines)
 *   - long text previews are truncated to avoid unbounded audit payloads
 */

let harness: Awaited<ReturnType<typeof createServiceHarness>>;

beforeEach(async () => {
  harness = await createServiceHarness();
});
afterEach(async () => {
  await harness.close();
});

async function bootstrapChannel() {
  const { orgId, admin } = await bootstrapOrg(harness.service);
  const channelId = await harness.service.createChannel(admin, "general", "public");
  return { orgId, admin, channelId };
}

describe("permission request context", () => {
  test("appendMessage auto-preserves text + stream metadata in the open request", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");

    const denied = await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "hello from an agent" } }],
      idempotencyKey: "ctx-1",
      autoRequestOnDeny: true,
    });
    if (!("denied" in denied) || !denied.denied) throw new Error("expected denial");

    const open = await harness.service.listOpenPermissionRequests(admin.orgId);
    const row = open.find((r) => r.requestId === denied.requestId);
    expect(row).toBeDefined();
    expect(row?.context).toMatchObject({
      kind: "message.append",
      streamType: "channel",
      streamId: channelId,
      idempotencyKey: "ctx-1",
      partCount: 1,
    });
    const parts = row?.context.parts as Array<Record<string, unknown>> | undefined;
    expect(parts?.[0]).toMatchObject({ index: 0, type: "text", text: "hello from an agent" });
  });

  test("tool_call / artifact parts are surfaced by type + top-level keys (not raw payload)", async () => {
    const { orgId, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");

    const denied = await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [
        { type: "tool_call", payload: { toolName: "run_migration", args: { table: "users" } } },
      ],
      idempotencyKey: "ctx-2",
      autoRequestOnDeny: true,
    });
    if (!("denied" in denied) || !denied.denied) throw new Error("expected denial");

    const [row] = await harness.service.listOpenPermissionRequests(bot.orgId, bot.actorId);
    const parts = row.context.parts as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ index: 0, type: "tool_call" });
    expect(parts[0].keys).toEqual(expect.arrayContaining(["toolName", "args"]));
    // Reviewer only sees what fields were set, not their values — the full
    // payload would need explicit opt-in if we add constraint matching.
    expect(parts[0]).not.toHaveProperty("args");
  });

  test("very long text parts are truncated to 500 chars in the context preview", async () => {
    const { orgId, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");
    const longText = "x".repeat(1200);

    const denied = await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: longText } }],
      idempotencyKey: "ctx-long",
      autoRequestOnDeny: true,
    });
    if (!("denied" in denied) || !denied.denied) throw new Error("expected denial");

    const [row] = await harness.service.listOpenPermissionRequests(bot.orgId);
    const parts = row.context.parts as Array<{ text?: string }>;
    expect(parts[0]?.text?.length).toBeLessThanOrEqual(501); // 500 + ellipsis
    expect(parts[0]?.text?.endsWith("…")).toBe(true);
  });

  test("createPermissionRequest accepts explicit context (channel-create case)", async () => {
    const { orgId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");

    const requestId = await harness.service.createPermissionRequest(
      bot,
      "channel:create",
      "org",
      orgId,
      { kind: "channel.create", name: "poems", visibility: "public" },
    );

    const [row] = await harness.service.listOpenPermissionRequests(orgId);
    expect(row.requestId).toBe(requestId);
    expect(row.context).toEqual({ kind: "channel.create", name: "poems", visibility: "public" });

    const request = await harness.service.getPermissionRequest(orgId, requestId);
    expect(request?.status).toBe("open");
    expect(request?.context).toEqual({ kind: "channel.create", name: "poems", visibility: "public" });
  });

  test("permission_request.created event carries the context through to plugins", async () => {
    const { orgId, channelId } = await bootstrapChannel();
    const bot = await principalFor(harness.service, orgId, "bot", "agent");

    const received: Array<Record<string, unknown>> = [];
    harness.bus.subscribe((e) => {
      if (e.type === "permission_request.created") received.push(e.payload as Record<string, unknown>);
    });

    await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "from the bus" } }],
      idempotencyKey: "ctx-bus",
      autoRequestOnDeny: true,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ action: "message:append", resourceType: "channel", resourceId: channelId });
    expect((received[0].context as { partCount?: number })?.partCount).toBe(1);
  });
});
