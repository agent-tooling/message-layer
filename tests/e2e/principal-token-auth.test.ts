import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { defaultServerConfig } from "../../src/config.js";
import { mintPrincipalToken } from "../../src/plugins/principal-token-auth.js";
import { startServer, type RunningServer } from "../../src/server-runtime.js";

/**
 * E2E tests for principal-token-auth.
 *
 * Confirm the plugin:
 *   1. Translates a signed JWT into `x-principal` for HTTP routes.
 *   2. Translates `?token=<jwt>` on WS upgrade into a usable principal.
 *   3. With `injectApiKey: true`, lets a token-only request pass
 *      `api-key-header-auth` without the client ever knowing the API key.
 *   4. Rejects expired tokens, wrong signatures, and replays.
 */

describe("principal-token-auth", () => {
  let server: RunningServer;
  const API_KEY = "ml-api-key-abc";
  const TOKEN_SECRET = "ml-token-secret-xyz";

  beforeEach(async () => {
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: [
          // Order matters: api-key first so its upgrade listener is added
          // first; principal-token-auth then prepends its own listener which
          // therefore runs FIRST on upgrade.
          {
            name: "api-key-header-auth",
            options: { envKey: "ML_TOKEN_TEST_API_KEY", strict: true },
          },
          {
            name: "principal-token-auth",
            options: {
              envKey: "ML_TOKEN_TEST_SECRET",
              injectApiKey: true,
              apiKeyEnvKey: "ML_TOKEN_TEST_API_KEY",
              replayWindowSeconds: 300,
            },
          },
          "websocket",
        ],
        port: 0,
      },
      env: {
        ML_TOKEN_TEST_API_KEY: API_KEY,
        ML_TOKEN_TEST_SECRET: TOKEN_SECRET,
      },
    });
  });

  afterEach(async () => {
    await server?.close();
  });

  async function bootstrap(): Promise<{
    orgId: string;
    adminId: string;
    channelId: string;
  }> {
    const orgId = await server.service.createOrg("Acme");
    const adminId = await server.service.createActor(orgId, "human", "admin");
    const admin = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "channel:admin", "message:append"],
      provider: "test",
    };
    const channelId = await server.service.createChannel(
      admin,
      "general",
      "public",
    );
    return { orgId, adminId, channelId };
  }

  function mint(input: {
    actorId: string;
    orgId: string;
    ttlSeconds?: number;
    jti?: string;
    secret?: string;
  }): string {
    return mintPrincipalToken({
      secret: input.secret ?? TOKEN_SECRET,
      actorId: input.actorId,
      orgId: input.orgId,
      scopes: ["channel:admin", "message:append"],
      ttlSeconds: input.ttlSeconds ?? 60,
      jti: input.jti ?? Math.random().toString(36).slice(2),
    });
  }

  test("HTTP: Bearer token is accepted in place of x-principal + x-api-key", async () => {
    const { orgId, adminId, channelId } = await bootstrap();
    const token = mint({ actorId: adminId, orgId });

    const res = await fetch(
      `${server.address}/v1/channels/${channelId}/members`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: { actorId: string }[] };
    expect(body.members.map((m) => m.actorId)).toContain(adminId);
  });

  test("HTTP: a token without the API key still passes because the plugin injects it", async () => {
    const { orgId, adminId } = await bootstrap();
    const token = mint({ actorId: adminId, orgId });

    // Hit a protected GET that needs both api-key and a principal.
    const res = await fetch(`${server.address}/v1/channels`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  test("HTTP: tampered signature is rejected", async () => {
    const { orgId, adminId } = await bootstrap();
    const valid = mint({ actorId: adminId, orgId });
    const tampered = `${valid.slice(0, -3)}aaa`;
    const res = await fetch(`${server.address}/v1/channels`, {
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.status).toBe(401);
  });

  test("HTTP: expired token is rejected", async () => {
    const { orgId, adminId } = await bootstrap();
    // Mint a token with negative ttl by overriding `now`.
    const expired = mintPrincipalToken({
      secret: TOKEN_SECRET,
      actorId: adminId,
      orgId,
      scopes: ["message:append"],
      ttlSeconds: 60,
      jti: "expired-1",
      now: () => new Date(Date.now() - 120_000),
    });
    const res = await fetch(`${server.address}/v1/channels`, {
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(res.status).toBe(401);
  });

  test("HTTP: replay of the same jti is rejected when replayWindowSeconds is set", async () => {
    const { orgId, adminId } = await bootstrap();
    const token = mint({ actorId: adminId, orgId, jti: "single-use-token" });
    const first = await fetch(`${server.address}/v1/channels`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${server.address}/v1/channels`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.status).toBe(401);
  });

  test("WS: ?token=<jwt> authenticates the upgrade without headers", async () => {
    const { orgId, adminId, channelId } = await bootstrap();
    const token = mint({ actorId: adminId, orgId, jti: "ws-1" });
    const wsUrl = `${server.address.replace(/^http/, "ws")}/v1/ws?token=${encodeURIComponent(token)}`;
    const ws = new NodeWebSocket(wsUrl);

    const welcomed = await new Promise<boolean>((resolve) => {
      ws.once("open", () => {
        ws.send(
          JSON.stringify({ type: "subscribe", streamId: channelId, fromSeq: 0 }),
        );
      });
      ws.once("message", (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === "welcome" || msg.type === "subscribed") {
            resolve(true);
          }
        } catch {
          resolve(false);
        }
      });
      ws.once("unexpected-response", () => resolve(false));
      ws.once("error", () => resolve(false));
    });
    ws.close();
    expect(welcomed).toBe(true);
  });

  test("WS: bad token does NOT inject a principal, upgrade fails", async () => {
    await bootstrap();
    const wsUrl = `${server.address.replace(/^http/, "ws")}/v1/ws?token=not-a-jwt`;
    const ws = new NodeWebSocket(wsUrl);

    const opened = await new Promise<boolean>((resolve) => {
      ws.once("open", () => resolve(true));
      ws.once("unexpected-response", () => resolve(false));
      ws.once("error", () => resolve(false));
    });
    expect(opened).toBe(false);
  });
});
