import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { connect, type SqlDatabase } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { createApp } from "../../src/http.js";
import { applyPluginSchemas, applyPluginsToApp, resolvePlugins } from "../../src/plugins.js";
import { MessageLayer } from "../../src/service.js";
import { defaultServerConfig } from "../../src/config.js";
import { startServer, type RunningServer } from "../../src/server-runtime.js";
import type { Principal } from "../../src/types.js";

type PluginHarness = {
  db: SqlDatabase;
  service: MessageLayer;
  app: ReturnType<typeof createApp>;
  close: () => Promise<void>;
};

async function makeHarness(): Promise<PluginHarness> {
  const db = await connect(`memory://ds-${Math.random().toString(16).slice(2)}`);
  const bus = new InProcessEventBus();
  const service = new MessageLayer(db, { bus });
  const app = createApp(service);
  const plugins = resolvePlugins(["durable-streams"]);
  await applyPluginSchemas(db, plugins);
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
        storage: { adapter: "pglite", path: "memory://ds" },
        artifacts: { kind: "memory" },
        plugins: ["durable-streams"],
      },
    },
    plugins,
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

async function http<T = unknown>(
  app: { fetch: (req: Request) => Promise<Response> },
  method: "GET" | "POST",
  path: string,
  principal: Principal,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-principal": JSON.stringify(principal),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const raw = await res.text();
  return {
    status: res.status,
    body: raw ? (JSON.parse(raw) as T) : ({} as T),
  };
}

describe("durable-streams plugin", () => {
  let h: PluginHarness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  test("supports create, append, live read, close backup, and commit to a message stream", async () => {
    const orgId = await h.service.createOrg("durable");
    const actorId = await h.service.createActor(orgId, "agent", "streamer");
    const principal: Principal = {
      actorId,
      orgId,
      scopes: ["channel:create", "message:append"],
      provider: "test",
    };
    const channelId = await h.service.createChannel(principal, "general", "public");

    const created = await http<{
      durableStreamId: string;
      status: string;
      offset: number;
    }>(h.app, "POST", "/v1/durable-streams", principal, {
      targetStreamId: channelId,
      targetStreamType: "channel",
      contentType: "text/plain",
      metadata: { source: "agent" },
    });
    expect(created.status).toBe(200);
    expect(created.body.status).toBe("open");
    const durableStreamId = created.body.durableStreamId;

    const pendingLiveRead = http<{
      chunks: Array<{ offset: number; text: string }>;
      nextOffset: number;
      upToDate: boolean;
    }>(
      h.app,
      "GET",
      `/v1/durable-streams/${durableStreamId}/read?offset=0&live=true&timeoutMs=2000`,
      principal,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    const appended = await http<{ offset: number; appended: number }>(
      h.app,
      "POST",
      `/v1/durable-streams/${durableStreamId}/chunks`,
      principal,
      {
        chunks: [{ text: "Hello " }, { text: "streaming world" }],
      },
    );
    expect(appended.status).toBe(200);
    expect(appended.body.appended).toBe(2);
    expect(appended.body.offset).toBe(2);

    const liveRead = await pendingLiveRead;
    expect(liveRead.status).toBe(200);
    expect(liveRead.body.chunks.map((chunk) => chunk.text).join("")).toBe(
      "Hello streaming world",
    );
    expect(liveRead.body.nextOffset).toBe(2);

    const committed = await http<{
      status: string;
      committedMessageId: string;
      backupKey: string;
    }>(
      h.app,
      "POST",
      `/v1/durable-streams/${durableStreamId}/commit`,
      principal,
      {},
    );
    expect(committed.status).toBe(200);
    expect(committed.body.status).toBe("committed");
    expect(committed.body.committedMessageId).toHaveLength(32);
    expect(committed.body.backupKey).toContain(`${orgId}/`);

    const messages = await h.service.listMessages(principal, channelId, 0, 10);
    expect(messages.at(-1)?.parts[0]?.type).toBe("text");
    expect(messages.at(-1)?.parts[0]?.payload.text).toBe("Hello streaming world");
  });

  test("durable_stream:read grant cannot bypass linked private stream membership", async () => {
    const orgId = await h.service.createOrg("durable-privacy");
    const ownerId = await h.service.createActor(orgId, "human", "owner");
    const intruderId = await h.service.createActor(orgId, "human", "intruder");
    const owner: Principal = {
      actorId: ownerId,
      orgId,
      scopes: ["channel:create", "channel:admin", "message:append", "grant:create"],
      provider: "test",
    };
    const intruder: Principal = {
      actorId: intruderId,
      orgId,
      scopes: [],
      provider: "test",
    };
    const privateChannel = await h.service.createChannel(owner, "private", "private");
    const created = await http<{ durableStreamId: string }>(h.app, "POST", "/v1/durable-streams", owner, {
      targetStreamId: privateChannel,
      targetStreamType: "channel",
    });
    expect(created.status).toBe(200);

    await h.service.createGrant(owner, intruderId, "org", orgId, "durable_stream:read");
    const denied = await http(h.app, "GET", `/v1/durable-streams/${created.body.durableStreamId}/head`, intruder);
    expect(denied.status).toBe(403);
  });
});

describe("durable-streams plugin via real running server", () => {
  let server: RunningServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  test("works end-to-end over network transport without mocks", async () => {
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        ...defaultServerConfig({}),
        plugins: ["durable-streams"],
        port: 0,
      },
    });

    const createOrgRes = await fetch(`${server.address}/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "net" }),
    });
    const orgBody = (await createOrgRes.json()) as { orgId: string };
    const actorRes = await fetch(`${server.address}/v1/actors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgId: orgBody.orgId,
        actorType: "agent",
        displayName: "net-agent",
      }),
    });
    const actorBody = (await actorRes.json()) as { actorId: string };
    const principal: Principal = {
      actorId: actorBody.actorId,
      orgId: orgBody.orgId,
      scopes: [],
      provider: "test",
    };

    const streamRes = await fetch(`${server.address}/v1/durable-streams`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-principal": JSON.stringify(principal),
      },
      body: JSON.stringify({ contentType: "text/plain" }),
    });
    expect(streamRes.status).toBe(200);
    const streamBody = (await streamRes.json()) as { durableStreamId: string };

    const appendRes = await fetch(
      `${server.address}/v1/durable-streams/${streamBody.durableStreamId}/chunks`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-principal": JSON.stringify(principal),
        },
        body: JSON.stringify({ chunks: [{ text: "net-ok" }] }),
      },
    );
    expect(appendRes.status).toBe(200);

    const readRes = await fetch(
      `${server.address}/v1/durable-streams/${streamBody.durableStreamId}/read?offset=0`,
      {
        headers: {
          "x-principal": JSON.stringify(principal),
        },
      },
    );
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as {
      chunks: Array<{ text: string }>;
      nextOffset: number;
    };
    expect(readBody.chunks.map((c) => c.text).join("")).toBe("net-ok");
    expect(readBody.nextOffset).toBe(1);
  });
});
