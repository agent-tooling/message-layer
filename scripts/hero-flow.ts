#!/usr/bin/env tsx
/**
 * Runnable end-to-end demo of the AGENTS.md "hero flow":
 *
 *   human + agent + app in one channel → permission request → artifact →
 *   derived knowledge → promotion → audit.
 *
 * Boots the real message-layer server in-process with the `scoped-knowledge`
 * plugin, drives everything through HTTP (no direct service calls), and
 * narrates each step to the terminal. Mirrors `tests/e2e/hero-flow.test.ts`.
 *
 *   pnpm run demo:hero
 *
 * Pass `--verbose` to echo every raw HTTP response.
 */

import { createHash } from "node:crypto";
import { defaultServerConfig } from "../src/config.js";
import { startServer, type RunningServer } from "../src/server-runtime.js";
import type { Principal } from "../src/types.js";

const verbose = process.argv.includes("--verbose");

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

function banner(title: string): void {
  const bar = "─".repeat(Math.max(0, 70 - title.length - 2));
  console.log(`\n${c.bold}${c.cyan}── ${title} ${bar}${c.reset}`);
}

function log(role: string, msg: string): void {
  console.log(`  ${c.dim}${role.padEnd(8)}${c.reset} ${msg}`);
}

function logErr(msg: string): void {
  console.log(`  ${c.red}✗${c.reset} ${msg}`);
}

async function main(): Promise<void> {
  let server: RunningServer | undefined;
  try {
    banner("boot");
    server = await startServer({
      port: 0,
      logger: verbose ? (m) => console.log(`${c.dim}${m}${c.reset}`) : () => {},
      config: {
        ...defaultServerConfig({}),
        port: 0,
        websocket: false,
        storage: {
          adapter: "pglite",
          path: `memory://hero-demo-${Math.random().toString(16).slice(2)}`,
        },
        artifacts: { kind: "memory", maxBytes: 5 * 1024 * 1024 },
        plugins: ["scoped-knowledge"],
      },
    });
    log("server", `listening on ${c.green}${server.address}${c.reset}`);

    const ctx = await bootstrap(server);

    banner("permission flow (app → human approval)");
    await permissionRoundTrip(server, ctx);

    banner("artifact upload + cross-actor download");
    const artifactId = await artifactFlow(server, ctx);

    banner("scoped-knowledge derivation");
    const promotedEntryId = await knowledgeFlow(server, ctx);

    banner("audit trail");
    await auditFlow(server, ctx);

    banner("done");
    log("ok", `${c.green}hero flow complete${c.reset}`);
    log("ok", `  artifact:        ${artifactId}`);
    log("ok", `  promoted entry:  ${promotedEntryId}`);
    log("ok", `  audit:           ${c.cyan}GET ${server.address}/v1/audit/rows${c.reset} with x-principal`);
  } catch (error) {
    logErr(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await server?.close();
  }
}

// ── step helpers ────────────────────────────────────────────────────────

type Actors = {
  orgId: string;
  admin: Principal;
  agent: Principal;
  app: Principal;
  outsider: Principal;
  channelId: string;
  privateChannelId: string;
};

async function bootstrap(server: RunningServer): Promise<Actors> {
  banner("bootstrap");
  const org = await json<{ orgId: string }>(server, "POST", "/v1/orgs", null, { name: "launch-prep" });
  log("admin", `created org ${c.magenta}${org.orgId}${c.reset}`);

  const adminActor = await json<{ actorId: string }>(server, "POST", "/v1/actors", null, {
    orgId: org.orgId,
    actorType: "human",
    displayName: "Alice (admin)",
  });
  const agentActor = await json<{ actorId: string }>(server, "POST", "/v1/actors", null, {
    orgId: org.orgId,
    actorType: "agent",
    displayName: "coder-bot",
  });
  const appActor = await json<{ actorId: string }>(server, "POST", "/v1/actors", null, {
    orgId: org.orgId,
    actorType: "app",
    displayName: "release-app",
  });
  const outsiderActor = await json<{ actorId: string }>(server, "POST", "/v1/actors", null, {
    orgId: org.orgId,
    actorType: "human",
    displayName: "curious-colleague",
  });

  const admin: Principal = {
    actorId: adminActor.actorId,
    orgId: org.orgId,
    scopes: [
      "channel:create",
      "channel:admin",
      "thread:create",
      "grant:create",
      "message:append",
      "knowledge:promote",
      "audit:read",
    ],
    provider: "demo",
  };
  const agent: Principal = { actorId: agentActor.actorId, orgId: org.orgId, scopes: [], provider: "demo" };
  const app: Principal = { actorId: appActor.actorId, orgId: org.orgId, scopes: [], provider: "demo" };
  const outsider: Principal = { actorId: outsiderActor.actorId, orgId: org.orgId, scopes: [], provider: "demo" };

  log("admin", `created human ${c.green}Alice${c.reset}, agent ${c.blue}coder-bot${c.reset}, app ${c.yellow}release-app${c.reset}, outsider ${c.dim}curious-colleague${c.reset}`);

  const channel = await json<{ channelId: string }>(server, "POST", "/v1/channels", admin, {
    name: "launch",
    visibility: "private",
  });
  const priv = await json<{ channelId: string }>(server, "POST", "/v1/channels", admin, {
    name: "finance",
    visibility: "private",
  });
  log("admin", `created private channel #launch (${c.magenta}${channel.channelId}${c.reset})`);
  log("admin", `created private channel #finance (separate scope)`);

  for (const actorId of [agent.actorId, app.actorId]) {
    await json(server, "POST", `/v1/channels/${channel.channelId}/members`, admin, { actorId });
  }
  log("admin", "added agent + app as members of #launch (outsider is not)");

  await json(server, "POST", "/v1/messages", admin, {
    streamId: channel.channelId,
    streamType: "channel",
    parts: [{ type: "text", payload: { text: "kickoff: cutting v1.0 today" } }],
    idempotencyKey: "demo-kickoff",
  });
  log("admin", "posted kickoff message");

  return {
    orgId: org.orgId,
    admin,
    agent,
    app,
    outsider,
    channelId: channel.channelId,
    privateChannelId: priv.channelId,
  };
}

async function permissionRoundTrip(server: RunningServer, ctx: Actors): Promise<void> {
  await json(server, "POST", "/v1/grants", ctx.admin, {
    actorId: ctx.agent.actorId,
    resourceType: "channel",
    resourceId: ctx.channelId,
    capability: "message:append",
  });
  await json(server, "POST", "/v1/grants", ctx.admin, {
    actorId: ctx.agent.actorId,
    resourceType: "channel",
    resourceId: ctx.channelId,
    capability: "artifact:register",
  });
  log("admin", "granted agent message:append + artifact:register on #launch");

  await json(server, "POST", "/v1/messages", ctx.agent, {
    streamId: ctx.channelId,
    streamType: "channel",
    parts: [{ type: "text", payload: { text: "plan: run tests, ship binary, announce in #launch" } }],
    idempotencyKey: "demo-agent-plan",
  });
  log("agent", "posted plan message");

  const denied = await raw(server, "POST", "/v1/messages", ctx.app, {
    streamId: ctx.channelId,
    streamType: "channel",
    parts: [{ type: "text", payload: { text: "build complete" } }],
    idempotencyKey: "demo-app-denied",
  });
  log("app", `tried to post → ${c.red}${denied.status}${c.reset} ${(await denied.clone().json()).code as string}`);

  const auto = await json<{ denied: boolean; requestId: string; capability: string }>(
    server,
    "POST",
    "/v1/messages",
    ctx.app,
    {
      streamId: ctx.channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "build complete" } }],
      idempotencyKey: "demo-app-auto",
      autoRequestOnDeny: true,
    },
  );
  log("app", `retried with autoRequestOnDeny → permission request ${c.yellow}${auto.requestId}${c.reset} opened`);

  const resolved = await json<{ status: string; grantId: string }>(
    server,
    "POST",
    `/v1/permission-requests/${auto.requestId}/resolve`,
    ctx.admin,
    { approve: true, notes: "ship it" },
  );
  log("admin", `approved request → grant ${c.green}${resolved.grantId}${c.reset}`);

  await json(server, "POST", "/v1/messages", ctx.app, {
    streamId: ctx.channelId,
    streamType: "channel",
    parts: [{ type: "text", payload: { text: "build complete, hash=deadbeef" } }],
    idempotencyKey: "demo-app-approved",
  });
  log("app", `posted after grant ${c.green}✓${c.reset}`);
}

async function artifactFlow(server: RunningServer, ctx: Actors): Promise<string> {
  const bytes = Buffer.from("fake tarball contents :: v1.0.0\n", "utf8");
  const expectedSha = createHash("sha256").update(bytes).digest("hex");

  const upload = await json<{ artifact: { id: string; sha256: string; size: number } }>(
    server,
    "POST",
    "/v1/artifacts",
    ctx.agent,
    {
      streamId: ctx.channelId,
      streamType: "channel",
      filename: "release-v1.0.0.tar",
      contentType: "application/x-tar",
      contentBase64: bytes.toString("base64"),
    },
  );
  log("agent", `uploaded ${c.yellow}release-v1.0.0.tar${c.reset} (${upload.artifact.size} bytes, sha256=${short(upload.artifact.sha256)})`);

  const dl = await raw(server, "GET", `/v1/artifacts/${upload.artifact.id}/content`, ctx.app);
  const received = Buffer.from(await dl.arrayBuffer());
  const receivedSha = createHash("sha256").update(received).digest("hex");
  if (receivedSha !== expectedSha) {
    throw new Error(`sha256 mismatch on download: got ${receivedSha}, expected ${expectedSha}`);
  }
  log("app", `downloaded artifact ${c.green}✓${c.reset} (verified sha256 ${short(receivedSha)})`);

  const outsiderDl = await raw(server, "GET", `/v1/artifacts/${upload.artifact.id}/content`, ctx.outsider);
  log("outsider", `download attempt → ${c.red}${outsiderDl.status}${c.reset} (private channel scope enforced)`);

  return upload.artifact.id;
}

async function knowledgeFlow(server: RunningServer, ctx: Actors): Promise<string> {
  const entries = await json<{ entries: Array<{ id: string; text: string; sourceVisibility: string; promoted: boolean }> }>(
    server,
    "GET",
    `/v1/knowledge?streamId=${ctx.channelId}`,
    ctx.admin,
  );
  log("plugin", `derived ${c.magenta}${entries.entries.length}${c.reset} knowledge entries for #launch (all sourceVisibility=private)`);
  for (const e of entries.entries) {
    log("entry", `  ${c.dim}${short(e.id)}${c.reset}  ${truncate(e.text, 60)}  promoted=${e.promoted}`);
  }

  const outsiderTry = await raw(server, "GET", `/v1/knowledge?streamId=${ctx.channelId}`, ctx.outsider);
  log("outsider", `GET /v1/knowledge?streamId=#launch → ${c.red}${outsiderTry.status}${c.reset} (scope inherited from source)`);

  const toPromote = entries.entries.find((e) => e.text.startsWith("plan:"))!;
  const promoted = await json<{ entry: { promoted: boolean; id: string } }>(
    server,
    "POST",
    `/v1/knowledge/${toPromote.id}/promote`,
    ctx.admin,
    { summary: "shareable release plan" },
  );
  log("admin", `promoted entry ${c.green}${short(promoted.entry.id)}${c.reset} → emits knowledge.promoted on the bus`);

  const promotedView = await json<{ entry: { id: string; promoted: boolean } }>(
    server,
    "GET",
    `/v1/knowledge/${toPromote.id}`,
    ctx.outsider,
  );
  log("outsider", `can now fetch promoted entry ${c.green}${short(promotedView.entry.id)}${c.reset}`);

  const stillPrivate = entries.entries.find((e) => e.text.startsWith("kickoff:"))!;
  const stillDenied = await raw(server, "GET", `/v1/knowledge/${stillPrivate.id}`, ctx.outsider);
  log("outsider", `but other entries remain ${c.red}${stillDenied.status}${c.reset} (derived visibility preserved)`);

  return toPromote.id;
}

async function auditFlow(server: RunningServer, ctx: Actors): Promise<void> {
  const rows = await json<{ rows: Array<{ eventType: string }> }>(server, "GET", "/v1/audit/rows", ctx.admin);
  const counts = new Map<string, number>();
  for (const r of rows.rows) counts.set(r.eventType, (counts.get(r.eventType) ?? 0) + 1);
  log("admin", `${c.magenta}${rows.rows.length}${c.reset} total audit entries:`);
  for (const [type, n] of [...counts.entries()].sort()) {
    log("       ", `${c.dim}${n}×${c.reset} ${type}`);
  }
  const verify = await json<{ valid: boolean; total: number; firstBadIndex: number | null }>(
    server,
    "GET",
    "/v1/audit/verify",
    ctx.admin,
  );
  const badge = verify.valid ? `${c.green}valid${c.reset}` : `${c.red}INVALID at index ${verify.firstBadIndex}${c.reset}`;
  log("admin", `audit chain verification: ${badge} (${verify.total} rows)`);
}

// ── http helpers ────────────────────────────────────────────────────────

async function json<T>(
  server: RunningServer,
  method: "GET" | "POST" | "DELETE",
  path: string,
  principal: Principal | null,
  body?: unknown,
): Promise<T> {
  const res = await raw(server, method, path, principal, body);
  const text = await res.text();
  if (verbose) console.log(`${c.dim}  ${method} ${path} → ${res.status} ${text}${c.reset}`);
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${text}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function raw(
  server: RunningServer,
  method: "GET" | "POST" | "DELETE",
  path: string,
  principal: Principal | null,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (principal) headers["x-principal"] = JSON.stringify(principal);
  return fetch(`${server.address}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function short(s: string): string {
  return s.length <= 8 ? s : `${s.slice(0, 8)}…`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

void main();
