import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { connect, type SqlDatabase } from "../../src/db.js";
import { InProcessEventBus } from "../../src/event-bus.js";
import { createApp } from "../../src/http.js";
import { MessageLayer } from "../../src/service.js";
import { InMemoryStorageAdapter } from "../../src/storage.js";
import type { Principal } from "../../src/types.js";
import { HttpClient, appFetcher } from "../helpers/http-client.js";

type Harness = {
  db: SqlDatabase;
  service: MessageLayer;
  http: HttpClient;
  app: ReturnType<typeof createApp>;
  close: () => Promise<void>;
};

let harness: Harness;

async function makeHarness(): Promise<Harness> {
  const db = await connect(`memory://artifacts-${Math.random().toString(16).slice(2)}`);
  const bus = new InProcessEventBus();
  const service = new MessageLayer(db, { bus, storage: new InMemoryStorageAdapter() });
  const app = createApp(service);
  const http = new HttpClient("http://localhost", appFetcher(app));
  return {
    db,
    service,
    http,
    app,
    close: async () => {
      await db.close?.();
    },
  };
}

async function bootstrap(): Promise<{ orgId: string; admin: Principal; channelId: string }> {
  const org = await harness.http.post<{ orgId: string }>("/v1/orgs", { name: "Acme" }, null);
  const actor = await harness.http.post<{ actorId: string }>(
    "/v1/actors",
    { orgId: org.body.orgId, actorType: "human", displayName: "admin" },
    null,
  );
  const admin: Principal = {
    actorId: actor.body.actorId,
    orgId: org.body.orgId,
    scopes: ["grant:create", "channel:create", "thread:create", "message:append", "channel:admin", "audit:read"],
    provider: "test",
  };
  const ch = await harness.http.post<{ channelId: string }>(
    "/v1/channels",
    { name: "general", visibility: "public" },
    admin,
  );
  return { orgId: org.body.orgId, admin, channelId: ch.body.channelId };
}

beforeEach(async () => {
  harness = await makeHarness();
});
afterEach(async () => {
  await harness.close();
});

describe("HTTP / artifacts", () => {
  test("upload -> list -> metadata -> content -> delete round trip", async () => {
    const { admin, channelId } = await bootstrap();
    const bytes = Buffer.from("hello artifacts");
    const sha = createHash("sha256").update(bytes).digest("hex");

    const upload = await harness.http.post<{ artifact: { id: string; size: number; sha256: string } }>(
      "/v1/artifacts",
      {
        streamId: channelId,
        streamType: "channel",
        filename: "hi.txt",
        contentType: "text/plain",
        contentBase64: bytes.toString("base64"),
      },
      admin,
    );
    expect(upload.status).toBe(200);
    expect(upload.body.artifact.sha256).toBe(sha);
    expect(upload.body.artifact.size).toBe(bytes.byteLength);
    const artifactId = upload.body.artifact.id;

    const list = await harness.http.get<{ artifacts: Array<{ id: string }> }>(
      `/v1/streams/${channelId}/artifacts`,
      admin,
    );
    expect(list.body.artifacts.map((a) => a.id)).toEqual([artifactId]);

    const meta = await harness.http.get<{ artifact: { filename: string } }>(
      `/v1/artifacts/${artifactId}`,
      admin,
    );
    expect(meta.body.artifact.filename).toBe("hi.txt");

    // Direct fetch for binary body since HttpClient parses JSON
    const contentRes = await harness.app.fetch(
      new Request(`http://localhost/v1/artifacts/${artifactId}/content`, {
        headers: { "x-principal": JSON.stringify(admin) },
      }),
    );
    expect(contentRes.status).toBe(200);
    expect(contentRes.headers.get("content-type")).toBe("text/plain");
    expect(contentRes.headers.get("x-artifact-sha256")).toBe(sha);
    const buf = Buffer.from(await contentRes.arrayBuffer());
    expect(buf.toString("utf8")).toBe("hello artifacts");

    const del = await harness.http.del(`/v1/artifacts/${artifactId}`, admin);
    expect(del.status).toBe(200);

    const afterDelete = await harness.http.get<{ artifacts: unknown[] }>(
      `/v1/streams/${channelId}/artifacts`,
      admin,
    );
    expect(afterDelete.body.artifacts).toHaveLength(0);

    const content404 = await harness.app.fetch(
      new Request(`http://localhost/v1/artifacts/${artifactId}/content`, {
        headers: { "x-principal": JSON.stringify(admin) },
      }),
    );
    expect(content404.status).toBe(404);
  });

  test("rejects invalid base64 with 400", async () => {
    const { admin, channelId } = await bootstrap();
    const res = await harness.http.post<{ code: string }>(
      "/v1/artifacts",
      {
        streamId: channelId,
        streamType: "channel",
        filename: "x.bin",
        contentType: "application/octet-stream",
        contentBase64: "",
      },
      admin,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION");
  });

  test("private channel access is enforced on upload + download", async () => {
    const { admin } = await bootstrap();
    const priv = await harness.http.post<{ channelId: string }>(
      "/v1/channels",
      { name: "secret" },
      admin,
    );
    const artifact = await harness.http.post<{ artifact: { id: string } }>(
      "/v1/artifacts",
      {
        streamId: priv.body.channelId,
        streamType: "channel",
        filename: "s.txt",
        contentType: "text/plain",
        contentBase64: Buffer.from("secret").toString("base64"),
      },
      admin,
    );
    expect(artifact.status).toBe(200);

    const orgId = admin.orgId;
    const alice = await harness.http.post<{ actorId: string }>(
      "/v1/actors",
      { orgId, actorType: "human", displayName: "alice" },
      null,
    );
    const alicePrincipal: Principal = { actorId: alice.body.actorId, orgId, scopes: [], provider: "test" };

    const aliceMeta = await harness.http.get(`/v1/artifacts/${artifact.body.artifact.id}`, alicePrincipal);
    expect(aliceMeta.status).toBe(403);

    const aliceContent = await harness.app.fetch(
      new Request(`http://localhost/v1/artifacts/${artifact.body.artifact.id}/content`, {
        headers: { "x-principal": JSON.stringify(alicePrincipal) },
      }),
    );
    expect(aliceContent.status).toBe(403);
  });
});
