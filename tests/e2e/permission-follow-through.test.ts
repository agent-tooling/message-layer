import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defaultServerConfig } from "../../src/config.js";
import { startServer, type RunningServer } from "../../src/server-runtime.js";
import {
  MessageLayerClient,
  parseWebhookDeliveryEnvelope,
  verifyWebhookSignature,
} from "../../src/sdk/index.js";

describe("permission follow-through + webhook sdk helpers", () => {
  let server: RunningServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: ["webhooks", "websocket", "request-logging", "event-logger"],
        port: 0,
      },
    });
    baseUrl = server.address;
  });

  afterEach(async () => {
    await server?.close();
  });

  test("single denied append auto-completes after approval without second prompt", async () => {
    const boot = new MessageLayerClient({ baseUrl });
    const { orgId } = await boot.createOrg("follow-through-org");
    const { actorId: adminId } = await boot.createActor({
      orgId,
      actorType: "human",
      displayName: "admin",
    });
    const { actorId: botId } = await boot.createActor({
      orgId,
      actorType: "agent",
      displayName: "bot",
    });

    const admin = new MessageLayerClient({
      baseUrl,
      principal: {
        actorId: adminId,
        orgId,
        scopes: ["channel:create", "grant:create", "message:append", "webhook:subscribe", "webhook:read"],
        provider: "test",
      },
    });
    const bot = new MessageLayerClient({
      baseUrl,
      principal: {
        actorId: botId,
        orgId,
        scopes: [],
        provider: "test",
      },
    });

    const { channelId } = await admin.createChannel("general", "public");
    const denied = await bot.appendMessage({
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "hello before approval" } }],
      idempotencyKey: "followthrough-1",
      autoRequestOnDeny: true,
    });
    expect("denied" in denied && denied.denied === true).toBe(true);
    if (!("denied" in denied) || denied.denied !== true) {
      throw new Error("expected denied append");
    }
    expect(denied.permissionRequestId).toMatch(/^[0-9a-f]{32}$/);

    const requestId = denied.permissionRequestId;
    const wait = bot.waitForPermissionResolution(requestId, {
      timeoutMs: 10000,
      pollIntervalMs: 50,
    });
    const resolved = await admin.resolvePermissionRequest(requestId, true, {
      notes: "approve for test",
      maxUses: 1,
    });
    expect(resolved.status).toBe("approved");
    const decision = await wait;
    expect(decision).toBe("approved");

    const approvedState = await bot.getPermissionRequest(requestId);
    expect(approvedState?.status).toBe("approved");

    const posted = await bot.appendMessage({
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "hello after approval" } }],
      idempotencyKey: "followthrough-2",
    });
    expect(posted.ok).toBe(true);

    const events = await admin.listStreamEvents(channelId, { fromSeq: 0 });
    expect(events.some((event) => event.type === "message.appended")).toBe(true);
  });

  test("webhook helpers create/manage subscriptions and validate signatures", async () => {
    const boot = new MessageLayerClient({ baseUrl });
    const { orgId } = await boot.createOrg("webhook-sdk-org");
    const { actorId } = await boot.createActor({
      orgId,
      actorType: "human",
      displayName: "owner",
    });
    const client = new MessageLayerClient({
      baseUrl,
      principal: {
        actorId,
        orgId,
        scopes: ["webhook:subscribe", "webhook:read", "channel:create", "grant:create"],
        provider: "test",
      },
    });

    const created = await client.createWebhookSubscription({
      endpoint: "https://example.com/webhook",
      eventTypes: ["message.appended"],
      secret: "secret1234",
    });
    expect(created.subscriptionId).toMatch(/^[0-9a-f]{32}$/);

    await client.setWebhookSubscriptionEnabled(created.subscriptionId, false);
    await client.setWebhookSubscriptionEnabled(created.subscriptionId, true);
    const listed = await client.listWebhookSubscriptions();
    expect(listed.some((sub) => sub.id === created.subscriptionId)).toBe(true);

    const rawBody = JSON.stringify({
      deliveryId: "delivery-1",
      subscriptionId: created.subscriptionId,
      event: {
        type: "message.appended",
        orgId,
        streamId: "stream-1",
        streamType: "channel",
        streamSeq: 1,
        actorId,
        payload: {},
      },
    });
    const signature = createHmac("sha256", "secret1234").update(rawBody).digest("hex");
    expect(
      verifyWebhookSignature({
        rawBody,
        signature,
        secret: "secret1234",
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        rawBody,
        signature: "00",
        secret: "secret1234",
      }),
    ).toBe(false);

    const envelope = parseWebhookDeliveryEnvelope(rawBody);
    expect(envelope?.deliveryId).toBe("delivery-1");
    expect(envelope?.event.type).toBe("message.appended");
  });
});
