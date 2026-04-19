import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  connect,
  createPgliteDatabase,
  createSqliteDatabase,
  type SqlDatabase,
  type StorageAdapter,
} from "../../src/db.js";
import { MessageLayer, PermissionError } from "../../src/service.js";
import type { Principal } from "../../src/types.js";

type AdapterFactory = (id: string) => Promise<SqlDatabase>;

// This suite intentionally uses real storage adapters only (pglite/sqlite).
// No mocks, spies, or fakes are allowed here.
const adapterFactories: Array<{ name: StorageAdapter; create: AdapterFactory }> = [
  {
    name: "pglite",
    create: (id: string) => createPgliteDatabase(`memory://${id}`),
  },
  {
    name: "sqlite",
    create: (id: string) => createSqliteDatabase(`file:/tmp/message-layer-${id}.sqlite`),
  },
];

async function withService<T>(factory: AdapterFactory, key: string, fn: (svc: MessageLayer) => Promise<T>): Promise<T> {
  const db = await factory(key);
  const svc = new MessageLayer(db);
  try {
    return await fn(svc);
  } finally {
    await db.close?.();
  }
}

export function describeAdapterMatrix(suiteName = "message-layer adapter matrix"): void {
  for (const adapter of adapterFactories) {
    describe(`${suiteName} adapter=${adapter.name}`, () => {
      test("connect() defaults to pglite", async () => {
        const db = await connect(`memory://default-${adapter.name}`);
        expect(db.adapter).toBe("pglite");
        await db.close?.();
      });
      test("org/channel/messages/thread/subscription flow", async () => {
        await withService(adapter.create, `${adapter.name}-flow`, async (svc) => {
          const orgId = await svc.createOrg("Acme");
          const adminId = await svc.createActor(orgId, "human", "admin");
          const botId = await svc.createActor(orgId, "agent", "bot");

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

          const channelId = await svc.createChannel(admin, "general");
          await svc.createGrant(admin, botId, "channel", channelId, "message:append");
          await svc.createGrant(admin, botId, "channel", channelId, "thread:create");

          const first = await svc.appendMessage(bot, {
            streamId: channelId,
            streamType: "channel",
            parts: [{ type: "text", payload: { text: "hello" } }],
            idempotencyKey: "bot-1",
          });
          const second = await svc.appendMessage(bot, {
            streamId: channelId,
            streamType: "channel",
            parts: [{ type: "tool_call", payload: { name: "lookup" } }],
            idempotencyKey: "bot-2",
          });
          const dup = await svc.appendMessage(bot, {
            streamId: channelId,
            streamType: "channel",
            parts: [{ type: "text", payload: { text: "ignored" } }],
            idempotencyKey: "bot-2",
          });

          expect(first.streamSeq).toBe(1);
          expect(second.streamSeq).toBe(2);
          expect(dup).toMatchObject({ idempotent: true, streamSeq: 2 });

          const messages = await svc.listMessages(admin, channelId);
          expect(messages.map((m) => m.streamSeq)).toEqual([1, 2]);

          const threadId = await svc.createThread(bot, channelId, first.messageId);
          await svc.createGrant(admin, botId, "thread", threadId, "message:append");
          const threadMsg = await svc.appendMessage(bot, {
            streamId: threadId,
            streamType: "thread",
            parts: [{ type: "text", payload: { text: "in thread" } }],
            idempotencyKey: "thread-1",
          });
          expect(threadMsg.streamSeq).toBe(1);

          const events = await svc.subscribe(admin, channelId, 0);
          expect(events.map((e) => e.type)).toEqual(["message.appended", "message.appended"]);
        });
      });

      test("permission request approval flow", async () => {
        await withService(adapter.create, `${adapter.name}-permissions`, async (svc) => {
          const orgId = await svc.createOrg("Acme");
          const adminId = await svc.createActor(orgId, "human", "admin");
          const userId = await svc.createActor(orgId, "human", "user");

          const admin: Principal = {
            actorId: adminId,
            orgId,
            scopes: ["grant:create", "channel:create"],
            provider: "local",
          };
          const user: Principal = {
            actorId: userId,
            orgId,
            scopes: [],
            provider: "local",
          };

          const channelId = await svc.createChannel(admin, "private");

          await expect(
            svc.appendMessage(user, {
              streamId: channelId,
              streamType: "channel",
              parts: [{ type: "text", payload: { text: "denied" } }],
              idempotencyKey: "u-1",
            }),
          ).rejects.toBeInstanceOf(PermissionError);

          const reqId = await svc.createPermissionRequest(user, "message:append", "channel", channelId);
          await svc.resolvePermissionRequest(admin, reqId, true);

          const ok = await svc.appendMessage(user, {
            streamId: channelId,
            streamType: "channel",
            parts: [{ type: "approval_response", payload: { approved: true } }],
            idempotencyKey: "u-2",
          });
          expect(ok.streamSeq).toBe(1);
        });
      });

      test("cursor/client/audit hash chain", async () => {
        await withService(adapter.create, `${adapter.name}-audit`, async (svc) => {
          const orgId = await svc.createOrg("Acme");
          const adminId = await svc.createActor(orgId, "human", "admin");
          const admin: Principal = {
            actorId: adminId,
            orgId,
            scopes: ["grant:create", "channel:create", "message:append"],
            provider: "local",
          };

          const channelId = await svc.createChannel(admin, "ops");
          const msg = await svc.appendMessage(admin, {
            streamId: channelId,
            streamType: "channel",
            parts: [{ type: "text", payload: { text: "check" } }],
            idempotencyKey: "a-1",
          });
          await svc.updateCursor(admin, channelId, msg.streamSeq, msg.streamSeq);
          const clientId = await svc.registerClient(admin, "wss://device-1", { platform: "ios" });
          expect(clientId).toBeTruthy();

          const rows = await svc.auditRows(orgId);
          expect(rows.length).toBeGreaterThan(3);

          let prev = "";
          for (const row of rows) {
            const expected = createHash("sha256")
              .update(`${prev}|${row.eventType}|${JSON.stringify(row.payload)}|${row.createdAt}`)
              .digest("hex");
            expect(row.eventHash).toBe(expected);
            prev = row.eventHash;
          }
        });
      });
    });
  }
}

describeAdapterMatrix();
