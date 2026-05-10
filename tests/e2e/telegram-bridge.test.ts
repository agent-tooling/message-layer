import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defaultServerConfig } from "../../src/config.js";
import { startServer, type RunningServer } from "../../src/server-runtime.js";
import { telegramBridgePlugin } from "../../src/plugins/telegram-bridge.js";
import type { Principal } from "../../src/types.js";
import { HttpClient } from "../helpers/http-client.js";
import { FakeTelegramServer } from "../helpers/fake-telegram-server.js";

type SetupResponse = {
  setupId: string;
  status: string;
  webhookUrl: string;
  bot: { id: string; username: string | null };
};

type BootstrapResult = {
  orgId: string;
  channelId: string;
  admin: Principal;
  human: Principal;
  agent: Principal;
  viewer: Principal;
};

async function waitFor(
  assertion: () => Promise<void> | void,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1200;
  const intervalMs = options.intervalMs ?? 20;
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - start >= timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

async function postWebhook(
  baseUrl: string,
  setupId: string,
  secretToken: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/v1/bridges/telegram/webhook/${setupId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secretToken,
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("telegram bridge e2e (real HTTP, no core mocks)", () => {
  let telegram: FakeTelegramServer | undefined;
  let server: RunningServer | undefined;
  let client: HttpClient | undefined;

  beforeEach(async () => {
    telegram = new FakeTelegramServer();
    await telegram.start();
    telegram.registerBot("bot-main-token", {
      id: 777001,
      username: "message_layer_bridge_bot",
    });
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: [
          telegramBridgePlugin({
            publicBaseUrl: "https://ml.example.com",
            webhookSecretSigningKey: "bridge-test-signing-key",
            telegramApiBaseUrl: telegram.endpoint,
            requestTimeoutMs: 1200,
          }),
        ],
        port: 0,
      },
    });
    client = new HttpClient(server.address);
  });

  afterEach(async () => {
    await server?.close();
    await telegram?.stop();
    server = undefined;
    telegram = undefined;
    client = undefined;
  });

  async function bootstrap(options: { grantHumanAppend: boolean }): Promise<BootstrapResult> {
    if (!client) throw new Error("client not initialized");
    const org = await client.post<{ orgId: string }>("/v1/orgs", { name: "BridgeOrg" }, null);
    const orgId = org.body.orgId;
    const adminActor = await client.post<{ actorId: string }>(
      "/v1/actors",
      { orgId, actorType: "human", displayName: "admin" },
      null,
    );
    const humanActor = await client.post<{ actorId: string }>(
      "/v1/actors",
      { orgId, actorType: "human", displayName: "andre" },
      null,
    );
    const agentActor = await client.post<{ actorId: string }>(
      "/v1/actors",
      { orgId, actorType: "agent", displayName: "assistant" },
      null,
    );
    const viewerActor = await client.post<{ actorId: string }>(
      "/v1/actors",
      { orgId, actorType: "human", displayName: "viewer" },
      null,
    );
    const admin: Principal = {
      actorId: adminActor.body.actorId,
      orgId,
      scopes: ["grant:create", "channel:create", "bridge:telegram:manage"],
      provider: "test",
    };
    const human: Principal = {
      actorId: humanActor.body.actorId,
      orgId,
      scopes: [],
      provider: "test",
    };
    const agent: Principal = {
      actorId: agentActor.body.actorId,
      orgId,
      scopes: ["message:append"],
      provider: "test",
    };
    const viewer: Principal = {
      actorId: viewerActor.body.actorId,
      orgId,
      scopes: [],
      provider: "test",
    };
    const channel = await client.post<{ channelId: string }>(
      "/v1/channels",
      { name: "bridge-general", visibility: "public" },
      admin,
    );
    if (options.grantHumanAppend) {
      await client.post<{ grantId: string }>(
        "/v1/grants",
        {
          actorId: human.actorId,
          resourceType: "channel",
          resourceId: channel.body.channelId,
          capability: "message:append",
        },
        admin,
      );
    }
    return {
      orgId,
      channelId: channel.body.channelId,
      admin,
      human,
      agent,
      viewer,
    };
  }

  async function createSetup(input: {
    admin: Principal;
    humanActorId: string;
    channelId: string;
    autoBindOnFirstMessage?: boolean;
    token?: string;
  }): Promise<SetupResponse> {
    if (!client) throw new Error("client not initialized");
    const setup = await client.post<SetupResponse>(
      "/v1/bridges/telegram/setups",
      {
        humanActorId: input.humanActorId,
        channelId: input.channelId,
        botToken: input.token ?? "bot-main-token",
        autoBindOnFirstMessage: input.autoBindOnFirstMessage,
      },
      input.admin,
    );
    expect(setup.status).toBe(200);
    return setup.body;
  }

  function latestWebhookSecret(): string {
    if (!telegram) throw new Error("telegram server not initialized");
    const call = telegram.lastCall("setWebhook");
    const token = call?.body.secret_token;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("missing webhook secret token");
    }
    return token;
  }

  test("supports setup, inbound bind/dedupe, outbound relay, and disable lifecycle", async () => {
    if (!client || !server || !telegram) throw new Error("test harness not initialized");
    const { admin, human, agent, channelId } = await bootstrap({ grantHumanAppend: true });
    const setup = await createSetup({
      admin,
      humanActorId: human.actorId,
      channelId,
    });
    expect(setup.status).toBe("pending_bind");
    expect(telegram.calls("setWebhook")).toHaveLength(1);
    expect(telegram.lastCall("setWebhook")?.body.url).toBe(setup.webhookUrl);

    const secret = latestWebhookSecret();
    const bad = await postWebhook(server.address, setup.setupId, "wrong-token", {
      update_id: 1,
      message: { message_id: 11, text: "hi", chat: { id: "4444", type: "private" } },
    });
    expect(bad.status).toBe(401);

    const noText = await postWebhook(server.address, setup.setupId, secret, {
      update_id: 2,
      message: { message_id: 12, chat: { id: "4444", type: "private" } },
    });
    expect(noText.status).toBe(200);
    expect(noText.body.reason).toBe("missing-text");

    const group = await postWebhook(server.address, setup.setupId, secret, {
      update_id: 3,
      message: { message_id: 13, text: "group-msg", chat: { id: "-100123", type: "group" } },
    });
    expect(group.status).toBe(200);
    expect(group.body.reason).toBe("unsupported-chat-type");

    const inbound = await postWebhook(server.address, setup.setupId, secret, {
      update_id: 1001,
      message: { message_id: 55, text: "hello from tg", chat: { id: "4444", type: "private" } },
    });
    expect(inbound.status).toBe(200);
    expect(typeof inbound.body.messageId).toBe("string");

    const duplicate = await postWebhook(server.address, setup.setupId, secret, {
      update_id: 1001,
      message: { message_id: 55, text: "hello from tg", chat: { id: "4444", type: "private" } },
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);

    const messages = await client.get<{
      messages: Array<{ actorId: string; parts: Array<{ payload: Record<string, unknown> }> }>;
    }>(`/v1/streams/${channelId}/messages`, admin);
    expect(messages.body.messages).toHaveLength(1);
    expect(messages.body.messages[0]?.actorId).toBe(human.actorId);
    expect(messages.body.messages[0]?.parts[0]?.payload).toMatchObject({
      text: "hello from tg",
      transport: "telegram",
      telegram: { setupId: setup.setupId, updateId: 1001, messageId: 55, chatId: "4444" },
    });

    await client.post(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "agent reply" } }],
        idempotencyKey: "agent-1",
      },
      agent,
    );
    await waitFor(() => {
      expect(telegram.calls("sendMessage")).toHaveLength(1);
    });
    expect(telegram.lastCall("sendMessage")?.body).toMatchObject({
      chat_id: "4444",
      text: "agent reply",
    });

    await client.post(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "human echo should be skipped" } }],
        idempotencyKey: "human-1",
      },
      human,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(telegram.calls("sendMessage")).toHaveLength(1);

    const disable = await client.post<{ ok: boolean }>(
      `/v1/bridges/telegram/setups/${setup.setupId}/disable`,
      {},
      admin,
    );
    expect(disable.status).toBe(200);
    expect(telegram.calls("deleteWebhook")).toHaveLength(1);

    await client.post(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "post-disable message" } }],
        idempotencyKey: "agent-2",
      },
      agent,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(telegram.calls("sendMessage")).toHaveLength(1);
  });

  test("records denied inbound status when bound human lacks message:append", async () => {
    if (!client || !server || !telegram) throw new Error("test harness not initialized");
    const { admin, human, channelId } = await bootstrap({ grantHumanAppend: false });
    const setup = await createSetup({
      admin,
      humanActorId: human.actorId,
      channelId,
    });
    const secret = latestWebhookSecret();
    const denied = await postWebhook(server.address, setup.setupId, secret, {
      update_id: 2001,
      message: { message_id: 91, text: "blocked", chat: { id: "5555", type: "private" } },
    });
    expect(denied.status).toBe(200);
    expect(denied.body.denied).toBe(true);
    expect(denied.body.reason).toBe("message-append-denied");

    const inboundRows = await server.db.query<{ status: string; error_message: string | null }>(
      "SELECT status,error_message FROM telegram_bridge_inbound_updates WHERE setup_id=? AND telegram_update_id=?",
      [setup.setupId, 2001],
    );
    expect(inboundRows.rows[0]).toMatchObject({
      status: "denied",
      error_message: "message-append-denied",
    });
  });

  test("enforces management visibility and chat mismatch handling", async () => {
    if (!client || !server || !telegram) throw new Error("test harness not initialized");
    const { admin, human, viewer, channelId } = await bootstrap({ grantHumanAppend: true });
    const setup = await createSetup({
      admin,
      humanActorId: human.actorId,
      channelId,
    });
    const secret = latestWebhookSecret();

    const listAsViewer = await client.get<{ setups: Array<{ setupId: string }> }>(
      "/v1/bridges/telegram/setups",
      viewer,
    );
    expect(listAsViewer.status).toBe(200);
    expect(listAsViewer.body.setups).toHaveLength(0);

    const bind = await postWebhook(server.address, setup.setupId, secret, {
      update_id: 3001,
      message: { message_id: 71, text: "bind chat", chat: { id: "7001", type: "private" } },
    });
    expect(bind.status).toBe(200);

    const mismatch = await postWebhook(server.address, setup.setupId, secret, {
      update_id: 3002,
      message: { message_id: 72, text: "wrong chat", chat: { id: "7002", type: "private" } },
    });
    expect(mismatch.status).toBe(200);
    expect(mismatch.body.reason).toBe("chat-mismatch");
  });

  test("rotates webhook secret and persists outbound failure metadata", async () => {
    if (!client || !server || !telegram) throw new Error("test harness not initialized");
    const { admin, human, agent, channelId } = await bootstrap({ grantHumanAppend: true });
    const setup = await createSetup({
      admin,
      humanActorId: human.actorId,
      channelId,
    });
    const firstSecret = latestWebhookSecret();

    await postWebhook(server.address, setup.setupId, firstSecret, {
      update_id: 4001,
      message: { message_id: 80, text: "bind before rotate", chat: { id: "9999", type: "private" } },
    });

    const rotate = await client.post<{ ok: boolean }>(
      `/v1/bridges/telegram/setups/${setup.setupId}/rotate-webhook-secret`,
      {},
      admin,
    );
    expect(rotate.status).toBe(200);
    expect(telegram.calls("setWebhook")).toHaveLength(2);
    const secondSecret = latestWebhookSecret();
    expect(secondSecret).not.toBe(firstSecret);

    const oldSecretAttempt = await postWebhook(server.address, setup.setupId, firstSecret, {
      update_id: 4002,
      message: { message_id: 81, text: "should fail auth", chat: { id: "9999", type: "private" } },
    });
    expect(oldSecretAttempt.status).toBe(401);

    const newSecretAttempt = await postWebhook(server.address, setup.setupId, secondSecret, {
      update_id: 4003,
      message: { message_id: 82, text: "new secret works", chat: { id: "9999", type: "private" } },
    });
    expect(newSecretAttempt.status).toBe(200);

    telegram.queueFailure("bot-main-token", "sendMessage", {
      body: { ok: false, description: "blocked by telegram test harness" },
    });
    await client.post(
      "/v1/messages",
      {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "trigger outbound failure" } }],
        idempotencyKey: "agent-fail-1",
      },
      agent,
    );

    await waitFor(async () => {
      const rows = await server.db.query<{ status: string; last_error: string | null; attempt_count: number }>(
        `SELECT status,last_error,attempt_count FROM telegram_bridge_outbound_deliveries
          WHERE setup_id=?
          ORDER BY created_at DESC
          LIMIT 1`,
        [setup.setupId],
      );
      expect(rows.rows[0]?.status).toBe("failed");
      expect(rows.rows[0]?.attempt_count).toBe(1);
      expect(rows.rows[0]?.last_error ?? "").toContain("ok=false");
    });
  });
});

