import { afterEach, describe, expect, test } from "vitest";
import { startServer, type RunningServer } from "../../src/server-runtime.js";
import type { Principal } from "../../src/types.js";

async function http<T = unknown>(
  server: RunningServer,
  method: "GET" | "POST",
  path: string,
  principal: Principal | null,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (principal) headers["x-principal"] = JSON.stringify(principal);
  const res = await fetch(`${server.address}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : ({} as T) };
}

async function eventually<T>(
  fetcher: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const intervalMs = options.intervalMs ?? 25;
  const start = Date.now();
  let last = await fetcher();
  while (!predicate(last)) {
    if (Date.now() - start > timeoutMs) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await fetcher();
  }
  return last;
}

describe("privacy cross-org conformance", () => {
  let server: RunningServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  test("org-B principal cannot read or discover org-A private data across plugin surfaces", async () => {
    server = await startServer({
      port: 0,
      logger: () => {},
      config: {
        port: 0,
        storage: { adapter: "pglite", path: `memory://privacy-cross-org-${Math.random().toString(16).slice(2)}` },
        artifacts: { kind: "memory" },
        plugins: ["memory", "search", "durable-streams", "durable-streams-storage"],
      },
    });

    const orgA = await http<{ orgId: string }>(server, "POST", "/v1/orgs", null, { name: "org-a" });
    const adminAActor = await http<{ actorId: string }>(server, "POST", "/v1/actors", null, {
      orgId: orgA.body.orgId,
      actorType: "human",
      displayName: "admin-a",
    });
    const adminA: Principal = {
      actorId: adminAActor.body.actorId,
      orgId: orgA.body.orgId,
      scopes: ["channel:create", "channel:admin", "message:append"],
      provider: "test",
    };
    const privateChannelA = await http<{ channelId: string }>(server, "POST", "/v1/channels", adminA, {
      name: "private-a",
      visibility: "private",
    });
    await http(server, "POST", "/v1/messages", adminA, {
      streamId: privateChannelA.body.channelId,
      streamType: "channel",
      idempotencyKey: "org-a-private-message",
      parts: [{ type: "text", payload: { text: "org-a confidential launch sequence" } }],
    });
    const memA = await eventually(
      () =>
        http<{ units: Array<{ id: string }> }>(
          server!,
          "GET",
          `/v1/memory?streamId=${privateChannelA.body.channelId}`,
          adminA,
        ),
      (res) => res.body.units.length > 0,
    );
    const memoryIdA = memA.body.units[0]!.id;
    const dsA = await http<{ durableStreamId: string }>(server, "POST", "/v1/durable-streams", adminA, {
      targetStreamId: privateChannelA.body.channelId,
      targetStreamType: "channel",
    });
    const dssA = await http<{ durableStreamId: string }>(server, "POST", "/v1/durable-streams-storage", adminA, {
      targetStreamId: privateChannelA.body.channelId,
      targetStreamType: "channel",
    });

    const orgB = await http<{ orgId: string }>(server, "POST", "/v1/orgs", null, { name: "org-b" });
    const adminBActor = await http<{ actorId: string }>(server, "POST", "/v1/actors", null, {
      orgId: orgB.body.orgId,
      actorType: "human",
      displayName: "admin-b",
    });
    const adminB: Principal = {
      actorId: adminBActor.body.actorId,
      orgId: orgB.body.orgId,
      scopes: ["channel:create", "message:append"],
      provider: "test",
    };

    const messages = await http(server, "GET", `/v1/streams/${privateChannelA.body.channelId}/messages`, adminB);
    expect(messages.status).toBe(403);

    const memoryStream = await http(server, "GET", `/v1/memory?streamId=${privateChannelA.body.channelId}`, adminB);
    expect(memoryStream.status).toBe(403);

    const memoryById = await http(server, "GET", `/v1/memory/${memoryIdA}`, adminB);
    expect(memoryById.status).toBe(404);

    const search = await http<{ hits: Array<{ entityId: string }> }>(
      server,
      "GET",
      `/v1/search?q=${encodeURIComponent("confidential")}`,
      adminB,
    );
    expect(search.status).toBe(200);
    expect(search.body.hits.find((hit) => hit.entityId === memoryIdA)).toBeUndefined();

    const dsHead = await http(server, "GET", `/v1/durable-streams/${dsA.body.durableStreamId}/head`, adminB);
    expect(dsHead.status).toBe(403);

    const dssHead = await http(server, "GET", `/v1/durable-streams-storage/${dssA.body.durableStreamId}/head`, adminB);
    expect(dssHead.status).toBe(403);
  });
});
