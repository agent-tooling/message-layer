import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { connect, type SqlDatabase } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { createApp } from "../../src/http.js";
import { applyPluginSchemas, applyPluginsToApp, resolvePlugins, type PluginSpec } from "../../src/plugins.js";
import { MessageLayer } from "../../src/service.js";
import type { Principal } from "../../src/types.js";

type Harness = {
  db: SqlDatabase;
  service: MessageLayer;
  app: ReturnType<typeof createApp>;
  close: () => Promise<void>;
};

type SinkDelivery = {
  eventType: string | null;
  streamId: string | null;
  body: unknown;
};

type Sink = {
  url: string;
  deliveries: SinkDelivery[];
  close: () => Promise<void>;
};

async function makeHarness(plugins: PluginSpec[]): Promise<Harness> {
  const db = await connect(`memory://webhook-privacy-${Math.random().toString(16).slice(2)}`);
  const bus = new InProcessEventBus();
  const service = new MessageLayer(db, { bus });
  const app = createApp(service);
  const resolved = resolvePlugins(plugins);
  await applyPluginSchemas(db, resolved);
  const dispose = await applyPluginsToApp(
    {
      app,
      db,
      service,
      bus,
      logger: () => {},
      env: {},
      config: {
        port: 0,
        storage: { adapter: "pglite", path: "memory://webhook-privacy" },
        artifacts: { kind: "memory" },
        plugins,
      },
    },
    resolved,
  );
  return {
    db,
    service,
    app,
    close: async () => {
      await dispose();
      await db.close?.();
    },
  };
}

async function startSink(): Promise<Sink> {
  const deliveries: SinkDelivery[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("method not allowed");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { raw };
    }
    const event = (
      parsed &&
      typeof parsed === "object" &&
      "event" in parsed &&
      (parsed as { event?: unknown }).event &&
      typeof (parsed as { event?: unknown }).event === "object"
    ) ? (parsed as { event: { type?: string; streamId?: string | null } }).event : null;
    deliveries.push({
      eventType: event?.type ?? null,
      streamId: event?.streamId ?? null,
      body: parsed,
    });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind sink server");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    deliveries,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

async function http<T = unknown>(
  app: { fetch: (req: Request) => Promise<Response> },
  method: "GET" | "POST",
  path: string,
  principal: Principal | null,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (principal) headers["x-principal"] = JSON.stringify(principal);
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : ({} as T) };
}

async function eventually(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const intervalMs = options.intervalMs ?? 25;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}

describe("webhooks privacy conformance", () => {
  let harness: Harness | undefined;
  let sink: Sink | undefined;

  afterEach(async () => {
    await harness?.close();
    await sink?.close();
    harness = undefined;
    sink = undefined;
  });

  test("org-wide subscriptions do not receive private-channel events", async () => {
    harness = await makeHarness([{ name: "webhooks", options: { allowPrivateNetworks: true } }]);
    sink = await startSink();

    const orgId = await harness.service.createOrg("hooks-privacy");
    const adminId = await harness.service.createActor(orgId, "human", "admin");
    const watcherId = await harness.service.createActor(orgId, "human", "watcher");

    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "channel:admin", "message:append"],
      provider: "test",
    };
    const watcher: Principal = {
      actorId: watcherId,
      orgId,
      scopes: ["webhook:subscribe", "webhook:read"],
      provider: "test",
    };

    const privateChannel = await harness.service.createChannel(admin, "private", "private");
    const publicChannel = await harness.service.createChannel(admin, "public", "public");

    const create = await http<{ subscriptionId: string }>(
      harness.app,
      "POST",
      "/v1/webhooks/subscriptions",
      watcher,
      {
        endpoint: `${sink.url}/hook`,
        eventTypes: ["message.appended"],
      },
    );
    expect(create.status).toBe(200);

    await harness.service.appendMessage(admin, {
      streamId: privateChannel,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "private payload should never leave" } }],
      idempotencyKey: "private-msg-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sink.deliveries.length).toBe(0);

    await harness.service.appendMessage(admin, {
      streamId: publicChannel,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "public payload can deliver" } }],
      idempotencyKey: "public-msg-1",
    });
    const delivered = await eventually(() => sink!.deliveries.length >= 1);
    expect(delivered).toBe(true);
    expect(sink.deliveries[0]?.streamId).toBe(publicChannel);
    expect(sink.deliveries[0]?.eventType).toBe("message.appended");
  });

  test("stream-scoped subscription stops delivering after membership revocation", async () => {
    harness = await makeHarness([{ name: "webhooks", options: { allowPrivateNetworks: true } }]);
    sink = await startSink();

    const orgId = await harness.service.createOrg("hooks-revoke");
    const adminId = await harness.service.createActor(orgId, "human", "admin");
    const memberId = await harness.service.createActor(orgId, "human", "member");

    const admin: Principal = {
      actorId: adminId,
      orgId,
      scopes: ["channel:create", "channel:admin", "message:append"],
      provider: "test",
    };
    const member: Principal = {
      actorId: memberId,
      orgId,
      scopes: ["webhook:subscribe", "webhook:read"],
      provider: "test",
    };

    const privateChannel = await harness.service.createChannel(admin, "secret", "private");
    await harness.service.addChannelMember(admin, privateChannel, memberId, "member");

    const create = await http<{ subscriptionId: string }>(
      harness.app,
      "POST",
      "/v1/webhooks/subscriptions",
      member,
      {
        endpoint: `${sink.url}/hook`,
        eventTypes: ["message.appended"],
        streamId: privateChannel,
      },
    );
    expect(create.status).toBe(200);

    await harness.service.appendMessage(admin, {
      streamId: privateChannel,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "before revoke" } }],
      idempotencyKey: "before-revoke-1",
    });
    const beforeDelivered = await eventually(() => sink!.deliveries.length >= 1);
    expect(beforeDelivered).toBe(true);

    await harness.service.removeChannelMember(admin, privateChannel, memberId);
    await harness.service.appendMessage(admin, {
      streamId: privateChannel,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "after revoke should be blocked" } }],
      idempotencyKey: "after-revoke-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sink.deliveries.length).toBe(1);
  });
});
