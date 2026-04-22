import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startServer, type RunningServer } from "../../src/server-runtime.js";
import { defaultServerConfig } from "../../src/config.js";
import { MessageLayerClient } from "../../src/sdk/index.js";

// End-to-end tests for the MessageLayerClient `apiKey` / `apiKeyHeader` options
// against a real running server that has the `api-key-header-auth` plugin enabled.
// Every request goes over the network (no in-process short-circuits).

const SECRET = "super-secret-key-for-tests";

describe("SDK apiKey / api-key-header-auth plugin", () => {
  let server: RunningServer;
  let address: string;

  beforeEach(async () => {
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: [
          {
            name: "api-key-header-auth",
            options: { envKey: "ML_TEST_API_KEY", strict: true },
          },
        ],
        port: 0,
      },
      env: { ML_TEST_API_KEY: SECRET },
    });
    address = server.address;
  });

  afterEach(async () => {
    await server?.close();
  });

  test("client without apiKey is rejected with 401 on every /v1/ endpoint", async () => {
    const anon = new MessageLayerClient({ baseUrl: address });
    await expect(anon.createOrg("ShouldFail")).rejects.toThrow("401");
  });

  test("client without apiKey gets 401 on authenticated routes too", async () => {
    const anon = new MessageLayerClient({
      baseUrl: address,
      principal: { actorId: "x", orgId: "y", scopes: [], provider: "test" },
    });
    await expect(anon.listChannels()).rejects.toThrow("401");
  });

  test("client with wrong apiKey is rejected with 401", async () => {
    const wrong = new MessageLayerClient({ baseUrl: address, apiKey: "wrong" });
    await expect(wrong.createOrg("ShouldFail")).rejects.toThrow("401");
  });

  test("client with correct apiKey can bootstrap an org and actors", async () => {
    const boot = new MessageLayerClient({ baseUrl: address, apiKey: SECRET });

    const { orgId } = await boot.createOrg("TestOrg");
    expect(orgId).toMatch(/^[0-9a-f]{32}$/);

    const { actorId: adminId } = await boot.createActor({
      orgId,
      displayName: "Admin",
      actorType: "human",
    });
    expect(adminId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("client with apiKey can run a full channel + message workflow", async () => {
    const boot = new MessageLayerClient({ baseUrl: address, apiKey: SECRET });

    const { orgId } = await boot.createOrg("WorkflowOrg");
    const { actorId: adminId } = await boot.createActor({
      orgId,
      displayName: "Admin",
      actorType: "human",
    });
    const admin = new MessageLayerClient({
      baseUrl: address,
      apiKey: SECRET,
      principal: {
        actorId: adminId,
        orgId,
        scopes: ["channel:create", "message:append", "grant:create"],
        provider: "test",
      },
    });

    // Create a channel
    const { channelId } = await admin.createChannel("general");
    expect(channelId).toBeTruthy();

    // List channels — must include the new one
    const channels = await admin.listChannels();
    expect(channels.map((c) => c.id)).toContain(channelId);

    // Append a message
    await admin.appendMessage({
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "hello secured world" } }],
      idempotencyKey: "sdk-key-test-1",
    });

    // Retrieve it
    const messages = await admin.listMessages(channelId);
    expect(messages).toHaveLength(1);
    expect((messages[0]!.parts[0]!.payload as { text: string }).text).toBe("hello secured world");

    // Grant check passes through the key too
    const hasGrant = await admin.checkCapability(adminId, "channel:create");
    expect(typeof hasGrant).toBe("boolean");
  });

  test("client with apiKey can list and revoke grants", async () => {
    const boot = new MessageLayerClient({ baseUrl: address, apiKey: SECRET });

    const { orgId } = await boot.createOrg("GrantOrg");
    const { actorId: adminId } = await boot.createActor({
      orgId,
      displayName: "Admin",
      actorType: "human",
    });
    const { actorId: agentId } = await boot.createActor({
      orgId,
      displayName: "Bot",
      actorType: "agent",
    });

    const grantor = new MessageLayerClient({
      baseUrl: address,
      apiKey: SECRET,
      principal: {
        actorId: adminId,
        orgId,
        scopes: ["grant:create"],
        provider: "test",
      },
    });

    const { grantId } = await grantor.createGrant({
      actorId: agentId,
      resourceType: "org",
      resourceId: orgId,
      capability: "message:append",
    });
    expect(grantId).toBeTruthy();

    const grants = await grantor.listActorGrants(agentId);
    expect(grants.map((g) => g.grantId)).toContain(grantId);

    // Revoke and confirm it's gone
    await grantor.revokeGrant(grantId);
    const after = await grantor.listActorGrants(agentId);
    expect(after.map((g) => g.grantId)).not.toContain(grantId);
  });

  test("custom apiKeyHeader option is honoured on both server and client", async () => {
    // Spin up a second server that expects a non-default header name.
    const server2 = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: [
          {
            name: "api-key-header-auth",
            options: { headerName: "x-ml-secret", envKey: "ML_CUSTOM_KEY" },
          },
        ],
        port: 0,
      },
      env: { ML_CUSTOM_KEY: "custom-secret" },
    });

    try {
      const addr2 = server2.address;

      // Default header (x-api-key) should NOT be accepted.
      const wrongHeader = new MessageLayerClient({
        baseUrl: addr2,
        apiKey: "custom-secret",
        // apiKeyHeader defaults to "x-api-key", which this server doesn't check
      });
      await expect(wrongHeader.createOrg("X")).rejects.toThrow("401");

      // Custom header should work.
      const correct = new MessageLayerClient({
        baseUrl: addr2,
        apiKey: "custom-secret",
        apiKeyHeader: "x-ml-secret",
      });
      const { orgId } = await correct.createOrg("CustomHeaderOrg");
      expect(orgId).toBeTruthy();
    } finally {
      await server2.close();
    }
  });
});
