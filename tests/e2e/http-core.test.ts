import { describe, expect, test } from "vitest";

import { connect, type StorageAdapter } from "../../src/db.js";
import { createApp } from "../../src/http.js";
import { applyPluginsToApp, resolvePlugins } from "../../src/plugins.js";
import { MessageLayer } from "../../src/service.js";
import type { Principal } from "../../src/types.js";

type AdapterCase = {
  name: StorageAdapter;
  pathFor: (id: string) => string;
};

const adapters: AdapterCase[] = [
  { name: "pglite", pathFor: (id) => `memory://http-${id}` },
  { name: "sqlite", pathFor: (id) => `/tmp/message-layer-http-${id}.sqlite` },
];

function principalHeader(principal: Principal): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-principal": JSON.stringify(principal),
  };
}

for (const adapter of adapters) {
  describe(`http core endpoints adapter=${adapter.name}`, () => {
    test("exposes full core API workflow", async () => {
      const db = await connect(adapter.pathFor("full"), adapter.name);
      try {
        const svc = new MessageLayer(db);
        const app = createApp(svc);
        const pluginContext = {
          app,
          service: svc,
          config: {
            port: 0,
            storage: { adapter: adapter.name, path: adapter.pathFor("cfg") },
            plugins: [],
          },
          logger: console,
        };
        const plugins = resolvePlugins([]);
        applyPluginsToApp(pluginContext, plugins);

        const orgRes = await app.request("http://localhost/v1/orgs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Acme" }),
        });
        expect(orgRes.status).toBe(200);
        const { orgId } = (await orgRes.json()) as { orgId: string };

        const adminRes = await app.request("http://localhost/v1/actors", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orgId, actorType: "human", displayName: "admin" }),
        });
        const botRes = await app.request("http://localhost/v1/actors", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orgId, actorType: "agent", displayName: "bot" }),
        });
        const userRes = await app.request("http://localhost/v1/actors", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orgId, actorType: "human", displayName: "user" }),
        });
        expect(adminRes.status).toBe(200);
        expect(botRes.status).toBe(200);
        expect(userRes.status).toBe(200);

        const adminId = ((await adminRes.json()) as { actorId: string }).actorId;
        const botId = ((await botRes.json()) as { actorId: string }).actorId;
        const userId = ((await userRes.json()) as { actorId: string }).actorId;

        const admin: Principal = {
          actorId: adminId,
          orgId,
          scopes: ["grant:create", "channel:create"],
          provider: "local",
        };
        const bot: Principal = {
          actorId: botId,
          orgId,
          scopes: [],
          provider: "local",
        };
        const user: Principal = {
          actorId: userId,
          orgId,
          scopes: [],
          provider: "local",
        };

        const channelRes = await app.request("http://localhost/v1/channels", {
          method: "POST",
          headers: principalHeader(admin),
          body: JSON.stringify({ name: "general" }),
        });
        expect(channelRes.status).toBe(200);
        const channelId = ((await channelRes.json()) as { channelId: string }).channelId;

        for (const grant of [
          { actorId: botId, resourceType: "channel", resourceId: channelId, capability: "message:append" },
          { actorId: botId, resourceType: "channel", resourceId: channelId, capability: "thread:create" },
        ]) {
          const grantRes = await app.request("http://localhost/v1/grants", {
            method: "POST",
            headers: principalHeader(admin),
            body: JSON.stringify(grant),
          });
          expect(grantRes.status).toBe(200);
        }

        const firstMsgRes = await app.request("http://localhost/v1/messages", {
          method: "POST",
          headers: principalHeader(bot),
          body: JSON.stringify({
            streamId: channelId,
            streamType: "channel",
            parts: [{ type: "text", payload: { text: "hello" } }],
            idempotencyKey: "bot-1",
          }),
        });
        expect(firstMsgRes.status).toBe(200);
        const firstMsg = (await firstMsgRes.json()) as { messageId: string; streamSeq: number };
        expect(firstMsg.streamSeq).toBe(1);

        const secondMsgRes = await app.request("http://localhost/v1/messages", {
          method: "POST",
          headers: principalHeader(bot),
          body: JSON.stringify({
            streamId: channelId,
            streamType: "channel",
            parts: [{ type: "tool_call", payload: { name: "lookup" } }],
            idempotencyKey: "bot-2",
          }),
        });
        expect(secondMsgRes.status).toBe(200);

        const threadRes = await app.request("http://localhost/v1/threads", {
          method: "POST",
          headers: principalHeader(bot),
          body: JSON.stringify({
            channelId,
            parentMessageId: firstMsg.messageId,
          }),
        });
        expect(threadRes.status).toBe(200);
        const threadId = ((await threadRes.json()) as { threadId: string }).threadId;

        const threadGrantRes = await app.request("http://localhost/v1/grants", {
          method: "POST",
          headers: principalHeader(admin),
          body: JSON.stringify({
            actorId: botId,
            resourceType: "thread",
            resourceId: threadId,
            capability: "message:append",
          }),
        });
        expect(threadGrantRes.status).toBe(200);

        const threadMsgRes = await app.request("http://localhost/v1/messages", {
          method: "POST",
          headers: principalHeader(bot),
          body: JSON.stringify({
            streamId: threadId,
            streamType: "thread",
            parts: [{ type: "text", payload: { text: "in thread" } }],
            idempotencyKey: "thread-1",
          }),
        });
        expect(threadMsgRes.status).toBe(200);

        const listRes = await app.request(`http://localhost/v1/streams/${channelId}/messages`, {
          method: "GET",
          headers: { "x-principal": JSON.stringify(admin) },
        });
        expect(listRes.status).toBe(200);
        const listed = (await listRes.json()) as { messages: Array<{ streamSeq: number }> };
        expect(listed.messages.map((m) => m.streamSeq)).toEqual([1, 2]);

        const subRes = await app.request(`http://localhost/v1/streams/${channelId}/subscribe?fromSeq=0`, {
          method: "GET",
          headers: { "x-principal": JSON.stringify(admin) },
        });
        expect(subRes.status).toBe(200);
        const events = (await subRes.json()) as { events: Array<{ type: string }> };
        expect(events.events.map((e) => e.type)).toEqual(["message.appended", "message.appended"]);

        const cursorRes = await app.request("http://localhost/v1/cursors", {
          method: "POST",
          headers: principalHeader(admin),
          body: JSON.stringify({
            streamId: channelId,
            lastSeenSeq: 2,
            lastAckSeq: 2,
          }),
        });
        expect(cursorRes.status).toBe(200);

        const clientRes = await app.request("http://localhost/v1/clients", {
          method: "POST",
          headers: principalHeader(admin),
          body: JSON.stringify({
            endpoint: "wss://device-1",
            metadata: { platform: "ios" },
          }),
        });
        expect(clientRes.status).toBe(200);

        const denyRes = await app.request("http://localhost/v1/messages", {
          method: "POST",
          headers: principalHeader(user),
          body: JSON.stringify({
            streamId: channelId,
            streamType: "channel",
            parts: [{ type: "text", payload: { text: "denied" } }],
            idempotencyKey: "u-1",
          }),
        });
        expect(denyRes.status).toBe(403);

        const reqRes = await app.request("http://localhost/v1/permission-requests", {
          method: "POST",
          headers: principalHeader(user),
          body: JSON.stringify({
            action: "message:append",
            resourceType: "channel",
            resourceId: channelId,
          }),
        });
        expect(reqRes.status).toBe(200);
        const requestId = ((await reqRes.json()) as { requestId: string }).requestId;

        const resolveRes = await app.request(
          `http://localhost/v1/permission-requests/${requestId}/resolve`,
          {
            method: "POST",
            headers: principalHeader(admin),
            body: JSON.stringify({ approve: true }),
          },
        );
        expect(resolveRes.status).toBe(200);

        const approvedRes = await app.request("http://localhost/v1/messages", {
          method: "POST",
          headers: principalHeader(user),
          body: JSON.stringify({
            streamId: channelId,
            streamType: "channel",
            parts: [{ type: "approval_response", payload: { approved: true } }],
            idempotencyKey: "u-2",
          }),
        });
        expect(approvedRes.status).toBe(200);

        const revokeGrantRes = await app.request("http://localhost/v1/grants", {
          method: "POST",
          headers: principalHeader(admin),
          body: JSON.stringify({
            actorId: botId,
            resourceType: "channel",
            resourceId: channelId,
            capability: "message:append",
          }),
        });
        const revokeGrantId = ((await revokeGrantRes.json()) as { grantId: string }).grantId;
        const revokeRes = await app.request(`http://localhost/v1/grants/${revokeGrantId}/revoke`, {
          method: "POST",
          headers: principalHeader(admin),
          body: JSON.stringify({}),
        });
        expect(revokeRes.status).toBe(200);
      } finally {
        await db.close?.();
      }
    });
  });
}
