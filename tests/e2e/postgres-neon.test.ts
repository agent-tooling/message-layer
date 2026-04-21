import { describe, expect, test } from "vitest";
import { connect } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { createApp } from "../../src/http.js";
import { MessageLayer } from "../../src/service.js";
import { HttpClient, appFetcher } from "../helpers/http-client.js";
import type { Principal } from "../../src/types.js";

const ENABLE_NEON_E2E = process.env.NEON_NEW_E2E === "1";
const describeIfNeon = ENABLE_NEON_E2E ? describe : describe.skip;

type ClaimableDbResponse = {
  connection_string?: string | null;
};

async function provisionNeonConnectionString(): Promise<string> {
  const explicit = process.env.NEON_TEST_DATABASE_URL;
  if (explicit && explicit.length > 0) return explicit;

  const response = await fetch("https://neon.new/api/v1/database", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: "message-layer-neon-e2e" }),
  });
  if (!response.ok) {
    throw new Error(
      `failed to provision neon.new test database: HTTP ${response.status}`,
    );
  }
  const payload = (await response.json()) as ClaimableDbResponse;
  if (!payload.connection_string || payload.connection_string.length === 0) {
    throw new Error("neon.new did not return a pooled connection_string");
  }
  return payload.connection_string;
}

describeIfNeon("Postgres adapter / neon.new", () => {
  test("runs core HTTP workflow on postgres adapter", async () => {
    const connectionString = await provisionNeonConnectionString();
    const db = await connect(connectionString, "postgres");
    try {
      const bus = new InProcessEventBus();
      const service = new MessageLayer(db, { bus });
      const app = createApp(service);
      const http = new HttpClient("http://localhost", appFetcher(app));

      const org = await http.post<{ orgId: string }>(
        "/v1/orgs",
        { name: "Neon E2E Org" },
        null,
      );
      expect(org.status).toBe(200);

      const adminActor = await http.post<{ actorId: string }>(
        "/v1/actors",
        { orgId: org.body.orgId, actorType: "human", displayName: "admin" },
        null,
      );
      expect(adminActor.status).toBe(200);

      const admin: Principal = {
        actorId: adminActor.body.actorId,
        orgId: org.body.orgId,
        scopes: [
          "grant:create",
          "channel:create",
          "thread:create",
          "message:append",
          "channel:admin",
        ],
        provider: "test",
      };

      const botActor = await http.post<{ actorId: string }>(
        "/v1/actors",
        { orgId: org.body.orgId, actorType: "agent", displayName: "bot" },
        null,
      );
      expect(botActor.status).toBe(200);

      const channel = await http.post<{ channelId: string }>(
        "/v1/channels",
        { name: "general", visibility: "public" },
        admin,
      );
      expect(channel.status).toBe(200);

      await http.post(
        "/v1/grants",
        {
          actorId: botActor.body.actorId,
          resourceType: "channel",
          resourceId: channel.body.channelId,
          capability: "message:append",
        },
        admin,
      );

      const botPrincipal: Principal = {
        actorId: botActor.body.actorId,
        orgId: org.body.orgId,
        scopes: [],
        provider: "test",
      };
      const append = await http.post<{ messageId: string; streamSeq: number }>(
        "/v1/messages",
        {
          streamId: channel.body.channelId,
          streamType: "channel",
          parts: [{ type: "text", payload: { text: "hello from neon" } }],
          idempotencyKey: "neon-1",
        },
        botPrincipal,
      );
      expect(append.status).toBe(200);
      expect(append.body.streamSeq).toBe(1);

      const listed = await http.get<{ messages: Array<{ streamSeq: number }> }>(
        `/v1/streams/${channel.body.channelId}/messages`,
        admin,
      );
      expect(listed.status).toBe(200);
      expect(listed.body.messages.map((m) => m.streamSeq)).toEqual([1]);
    } finally {
      await db.close?.();
    }
  }, 30_000);
});
