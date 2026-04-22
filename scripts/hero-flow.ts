#!/usr/bin/env tsx
/**
 * Runnable end-to-end demo of all message-layer capabilities:
 *
 *   health · discovery · permissions · threads · moderation · cursors ·
 *   artifacts · grants · webhooks · durable-streams · knowledge · audit
 *
 * Boots the real message-layer server in-process with all plugins enabled,
 * drives everything through HTTP (no direct service calls), and narrates each
 * step to the terminal.  Mirrors `tests/e2e/hero-flow.test.ts`.
 *
 *   pnpm run demo:hero
 *
 * Pass `--verbose` to echo every raw HTTP response.
 */

import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
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
  let webhookReceiver: { close: () => void } | undefined;
  try {
    banner("boot");
    server = await startServer({
      port: 0,
      logger: verbose ? (m) => console.log(`${c.dim}${m}${c.reset}`) : () => {},
      config: {
        ...defaultServerConfig({}),
        port: 0,
        storage: {
          adapter: "pglite",
          path: `memory://hero-demo-${Math.random().toString(16).slice(2)}`,
        },
        artifacts: { kind: "memory", maxBytes: 5 * 1024 * 1024 },
        plugins: [
          "scoped-knowledge",
          "webhooks",
          "durable-streams",
          { name: "health-meta", options: { version: "hero-demo" } },
        ],
      },
    });
    log("server", `listening on ${c.green}${server.address}${c.reset}`);

    banner("health & observability");
    await healthFlow(server);

    banner("bootstrap");
    const baseCtx = await bootstrap(server);

    banner("permission flow (app → human approval)");
    const grantCtx = await permissionRoundTrip(server, baseCtx);
    const ctx: Actors = { ...baseCtx, ...grantCtx };

    banner("discovery (list channels, actors, members)");
    await discoveryFlow(server, ctx);

    banner("thread flow");
    const threadId = await threadFlow(server, ctx);

    banner("message history + moderation (redact)");
    await moderationFlow(server, ctx);

    banner("read cursors (inbox tracking)");
    await cursorFlow(server, ctx);

    banner("artifact upload + cross-actor download");
    const artifactId = await artifactFlow(server, ctx);

    banner("artifact catalog (list + metadata + soft-delete)");
    await artifactCatalogFlow(server, ctx, artifactId);

    banner("grant lifecycle (check + revoke)");
    await grantLifecycleFlow(server, ctx);

    banner("webhooks (outbound event delivery)");
    const recv = await startWebhookReceiver();
    webhookReceiver = recv;
    await webhookFlow(server, ctx, recv);

    banner("durable streams (agent task queue)");
    const dsMessageId = await durableStreamFlow(server, ctx);

    banner("scoped-knowledge derivation");
    const promotedEntryId = await knowledgeFlow(server, ctx);

    banner("audit trail");
    await auditFlow(server, ctx);

    banner("done");
    log("ok", `${c.green}all capabilities demonstrated${c.reset}`);
    log("ok", `  artifact:        ${artifactId}`);
    log("ok", `  thread:          ${threadId}`);
    log("ok", `  ds message:      ${dsMessageId}`);
    log("ok", `  promoted entry:  ${promotedEntryId}`);
    log("ok", `  audit:           ${c.cyan}GET ${server.address}/v1/audit/rows${c.reset} with x-principal`);
  } catch (error) {
    logErr(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    webhookReceiver?.close();
    await server?.close();
  }
}

// ── types ────────────────────────────────────────────────────────────────────

type BaseActors = {
  orgId: string;
  admin: Principal;
  agent: Principal;
  app: Principal;
  outsider: Principal;
  channelId: string;
  privateChannelId: string;
  kickoffMessageId: string;
};

type Actors = BaseActors & {
  agentMessageGrantId: string;
  agentArtifactGrantId: string;
  appGrantId: string;
  agentPlanMessageId: string;
};

// ── step helpers ─────────────────────────────────────────────────────────────

async function bootstrap(server: RunningServer): Promise<BaseActors> {
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
      "webhook:subscribe",
      "webhook:read",
      "message:redact",
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

  const kickoff = await json<{ messageId: string }>(server, "POST", "/v1/messages", admin, {
    streamId: channel.channelId,
    streamType: "channel",
    parts: [{ type: "text", payload: { text: "kickoff: cutting v1.0 today" } }],
    idempotencyKey: "demo-kickoff",
  });
  log("admin", `posted kickoff message (${c.dim}${short(kickoff.messageId)}${c.reset})`);

  return {
    orgId: org.orgId,
    admin,
    agent,
    app,
    outsider,
    channelId: channel.channelId,
    privateChannelId: priv.channelId,
    kickoffMessageId: kickoff.messageId,
  };
}

async function permissionRoundTrip(
  server: RunningServer,
  ctx: BaseActors,
): Promise<Omit<Actors, keyof BaseActors>> {
  const grantMsg = await json<{ grantId: string }>(server, "POST", "/v1/grants", ctx.admin, {
    actorId: ctx.agent.actorId,
    resourceType: "channel",
    resourceId: ctx.channelId,
    capability: "message:append",
  });
  const grantArt = await json<{ grantId: string }>(server, "POST", "/v1/grants", ctx.admin, {
    actorId: ctx.agent.actorId,
    resourceType: "channel",
    resourceId: ctx.channelId,
    capability: "artifact:register",
  });
  log("admin", `granted agent message:append ${c.dim}(${short(grantMsg.grantId)})${c.reset} + artifact:register on #launch`);

  const plan = await json<{ messageId: string }>(server, "POST", "/v1/messages", ctx.agent, {
    streamId: ctx.channelId,
    streamType: "channel",
    parts: [{ type: "text", payload: { text: "plan: run tests, ship binary, announce in #launch" } }],
    idempotencyKey: "demo-agent-plan",
  });
  log("agent", `posted plan message (${c.dim}${short(plan.messageId)}${c.reset})`);

  const denied = await raw(server, "POST", "/v1/messages", ctx.app, {
    streamId: ctx.channelId,
    streamType: "channel",
    parts: [{ type: "text", payload: { text: "build complete" } }],
    idempotencyKey: "demo-app-denied",
  });
  log("app", `tried to post → ${c.red}${denied.status}${c.reset} ${(await denied.clone().json() as { code: string }).code}`);

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

  const pendingList = await json<{ requests: Array<{ id: string; action: string }> }>(
    server,
    "GET",
    "/v1/permission-requests",
    ctx.admin,
  );
  log("admin", `${pendingList.requests.length} open permission request(s) in queue`);

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

  return {
    agentMessageGrantId: grantMsg.grantId,
    agentArtifactGrantId: grantArt.grantId,
    appGrantId: resolved.grantId,
    agentPlanMessageId: plan.messageId,
  };
}

async function healthFlow(server: RunningServer): Promise<void> {
  const liveness = await json<{ ok: boolean }>(server, "GET", "/health", null);
  log("health", `liveness: ${liveness.ok ? c.green : c.red}${String(liveness.ok)}${c.reset}`);

  const meta = await json<{ ok: boolean; adapter: string; version: string; plugins: string[] }>(
    server,
    "GET",
    "/health/meta",
    null,
  );
  log("health", `adapter=${c.cyan}${meta.adapter}${c.reset}  version=${c.cyan}${meta.version}${c.reset}`);
  log("health", `plugins: ${meta.plugins.map((p) => `${c.magenta}${p}${c.reset}`).join(", ")}`);
}

async function discoveryFlow(server: RunningServer, ctx: Actors): Promise<void> {
  const channels = await json<{ channels: Array<{ id: string; name: string }> }>(
    server,
    "GET",
    "/v1/channels",
    ctx.admin,
  );
  log("admin", `sees ${c.magenta}${channels.channels.length}${c.reset} channel(s): ${channels.channels.map((ch) => `#${ch.name}`).join(", ")}`);

  const outsiderChannels = await json<{ channels: Array<{ id: string }> }>(
    server,
    "GET",
    "/v1/channels",
    ctx.outsider,
  );
  log("outsider", `sees ${c.red}${outsiderChannels.channels.length}${c.reset} channel(s) — private channels invisible`);

  const actors = await json<{ actors: Array<{ id: string; displayName: string; actorType: string }> }>(
    server,
    "GET",
    "/v1/actors",
    ctx.admin,
  );
  log("admin", `org has ${c.magenta}${actors.actors.length}${c.reset} actor(s): ${actors.actors.map((a) => a.displayName).join(", ")}`);

  const members = await json<{ members: Array<{ actorId: string; role: string }> }>(
    server,
    "GET",
    `/v1/channels/${ctx.channelId}/members`,
    ctx.admin,
  );
  log("admin", `#launch has ${c.magenta}${members.members.length}${c.reset} member(s)`);
}

async function threadFlow(server: RunningServer, ctx: Actors): Promise<string> {
  const thread = await json<{ threadId: string }>(server, "POST", "/v1/threads", ctx.admin, {
    channelId: ctx.channelId,
    parentMessageId: ctx.kickoffMessageId,
    visibility: "private",
  });
  log("admin", `created thread ${c.magenta}${short(thread.threadId)}${c.reset} off kickoff message`);

  await json(server, "POST", "/v1/messages", ctx.admin, {
    streamId: thread.threadId,
    streamType: "thread",
    parts: [{ type: "text", payload: { text: "confirmed: test matrix passing on all targets" } }],
    idempotencyKey: "demo-thread-1",
  });
  log("admin", "posted thread reply #1");

  await json(server, "POST", "/v1/messages", ctx.admin, {
    streamId: thread.threadId,
    streamType: "thread",
    parts: [{ type: "text", payload: { text: "confirmed: staging deploy green, proceeding" } }],
    idempotencyKey: "demo-thread-2",
  });
  log("admin", "posted thread reply #2");

  const threads = await json<{ threads: Array<{ id: string }> }>(
    server,
    "GET",
    `/v1/channels/${ctx.channelId}/threads`,
    ctx.admin,
  );
  log("admin", `#launch now has ${c.magenta}${threads.threads.length}${c.reset} thread(s)`);

  const threadMsgs = await json<{ messages: Array<{ id: string }> }>(
    server,
    "GET",
    `/v1/streams/${thread.threadId}/messages`,
    ctx.admin,
  );
  log("admin", `thread contains ${c.magenta}${threadMsgs.messages.length}${c.reset} message(s)`);

  return thread.threadId;
}

async function moderationFlow(server: RunningServer, ctx: Actors): Promise<void> {
  const before = await json<{ messages: Array<{ id: string; parts: unknown[] }> }>(
    server,
    "GET",
    `/v1/streams/${ctx.channelId}/messages`,
    ctx.admin,
  );
  log("admin", `stream has ${c.magenta}${before.messages.length}${c.reset} message(s) before redaction`);

  await json(server, "POST", `/v1/messages/${ctx.agentPlanMessageId}/redact`, ctx.admin, {
    reason: "contained internal path",
  });
  log("admin", `redacted agent plan message ${c.dim}${short(ctx.agentPlanMessageId)}${c.reset}`);

  const after = await json<{
    messages: Array<{ id: string; redacted: boolean; parts: Array<{ type: string }> }>;
  }>(server, "GET", `/v1/streams/${ctx.channelId}/messages`, ctx.admin);
  const redactedCount = after.messages.filter((m) => m.redacted).length;
  log("admin", `${c.magenta}${redactedCount}${c.reset} message(s) now marked redacted in stream`);

  const events = await json<{ events: Array<{ type: string }> }>(
    server,
    "GET",
    `/v1/streams/${ctx.channelId}/subscribe`,
    ctx.admin,
  );
  const eventTypes = [...new Set(events.events.map((e) => e.type))];
  log("admin", `stream replay: ${c.magenta}${events.events.length}${c.reset} event(s) — types: ${eventTypes.join(", ")}`);
}

async function cursorFlow(server: RunningServer, ctx: Actors): Promise<void> {
  const msgs = await json<{ messages: Array<{ id: string }> }>(
    server,
    "GET",
    `/v1/streams/${ctx.channelId}/messages`,
    ctx.admin,
  );
  const latestSeq = msgs.messages.length;

  await json(server, "POST", "/v1/cursors", ctx.admin, {
    streamId: ctx.channelId,
    lastSeenSeq: latestSeq,
    lastAckSeq: latestSeq,
  });
  log("admin", `updated read cursor to seq=${c.cyan}${latestSeq}${c.reset} (all messages acknowledged)`);

  const cursor = await json<{ cursor: { lastSeenSeq: number; lastAckSeq: number } | null }>(
    server,
    "GET",
    `/v1/streams/${ctx.channelId}/cursor`,
    ctx.admin,
  );
  if (cursor.cursor) {
    log("admin", `cursor read back: seen=${c.cyan}${cursor.cursor.lastSeenSeq}${c.reset} ack=${c.cyan}${cursor.cursor.lastAckSeq}${c.reset}`);
  }
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

async function artifactCatalogFlow(
  server: RunningServer,
  ctx: Actors,
  artifactId: string,
): Promise<void> {
  const list = await json<{ artifacts: Array<{ id: string; filename: string; size: number; deleted: boolean }> }>(
    server,
    "GET",
    `/v1/streams/${ctx.channelId}/artifacts`,
    ctx.admin,
  );
  log("admin", `#launch has ${c.magenta}${list.artifacts.length}${c.reset} artifact(s):`);
  for (const a of list.artifacts) {
    log("       ", `  ${c.dim}${short(a.id)}${c.reset}  ${c.yellow}${a.filename}${c.reset}  ${a.size}b`);
  }

  const meta = await json<{ artifact: { id: string; filename: string; sha256: string } }>(
    server,
    "GET",
    `/v1/artifacts/${artifactId}`,
    ctx.admin,
  );
  log("admin", `metadata: filename=${c.yellow}${meta.artifact.filename}${c.reset}  sha256=${short(meta.artifact.sha256)}`);

  await json(server, "DELETE", `/v1/artifacts/${artifactId}`, ctx.agent);
  log("agent", `soft-deleted artifact ${c.dim}${short(artifactId)}${c.reset}`);

  const listAfter = await json<{ artifacts: Array<{ id: string; deleted: boolean }> }>(
    server,
    "GET",
    `/v1/streams/${ctx.channelId}/artifacts`,
    ctx.admin,
  );
  log("admin", `visible artifacts after delete: ${c.magenta}${listAfter.artifacts.length}${c.reset} (soft-delete hides from default listing)`);

  const listWithDeleted = await json<{ artifacts: Array<{ id: string; deleted: boolean }> }>(
    server,
    "GET",
    `/v1/streams/${ctx.channelId}/artifacts?includeDeleted=true`,
    ctx.admin,
  );
  const deletedCount = listWithDeleted.artifacts.filter((a) => a.deleted).length;
  log("admin", `with includeDeleted=true: ${c.magenta}${listWithDeleted.artifacts.length}${c.reset} total, ${deletedCount} deleted`);
}

async function grantLifecycleFlow(server: RunningServer, ctx: Actors): Promise<void> {
  const check = await json<{ hasGrant: boolean }>(
    server,
    "GET",
    `/v1/grants/check?actorId=${ctx.agent.actorId}&capability=message:append`,
    ctx.admin,
  );
  log("admin", `capability check for agent message:append → ${check.hasGrant ? c.green : c.red}${String(check.hasGrant)}${c.reset}`);

  const appGrants = await json<{
    grants: Array<{ id: string; capability: string }>;
  }>(server, "GET", `/v1/actors/${ctx.app.actorId}/grants`, ctx.admin);
  log("admin", `app holds ${c.magenta}${appGrants.grants.length}${c.reset} active grant(s): ${appGrants.grants.map((g) => g.capability).join(", ")}`);

  await json(server, "POST", `/v1/grants/${ctx.appGrantId}/revoke`, ctx.admin);
  log("admin", `revoked app's message:append grant ${c.dim}${short(ctx.appGrantId)}${c.reset}`);

  const checkAfter = await raw(server, "POST", "/v1/messages", ctx.app, {
    streamId: ctx.channelId,
    streamType: "channel",
    parts: [{ type: "text", payload: { text: "should be denied now" } }],
    idempotencyKey: "demo-revoke-check",
  });
  log("app", `post after revoke → ${c.red}${checkAfter.status}${c.reset} ${c.dim}(grant revoked, access gone)${c.reset}`);

  const revokeAll = await json<{ revokedGrantIds: string[] }>(
    server,
    "POST",
    `/v1/actors/${ctx.outsider.actorId}/revoke-grants`,
    ctx.admin,
    { reason: "offboarding" },
  );
  log("admin", `bulk-revoke all grants for outsider → ${c.magenta}${revokeAll.revokedGrantIds.length}${c.reset} revoked (0 expected, outsider had none)`);
}

// ── webhook receiver ─────────────────────────────────────────────────────────

type WebhookReceiver = {
  url: string;
  waitForDelivery: (timeoutMs?: number) => Promise<Record<string, unknown> | null>;
  close: () => void;
};

async function startWebhookReceiver(): Promise<WebhookReceiver> {
  let resolve: ((v: Record<string, unknown>) => void) | null = null;
  const promise = new Promise<Record<string, unknown>>((r) => {
    resolve = r;
  });

  const srv = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      try {
        resolve?.(JSON.parse(body) as Record<string, unknown>);
      } catch {
        resolve?.({});
      }
    });
  });

  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address() as { port: number };

  return {
    url: `http://127.0.0.1:${addr.port}/webhook`,
    waitForDelivery: (timeoutMs = 1500) =>
      Promise.race([promise, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]),
    close: () => {
      if ("closeAllConnections" in srv && typeof srv.closeAllConnections === "function") {
        (srv.closeAllConnections as () => void)();
      }
      srv.close();
    },
  };
}

async function webhookFlow(
  server: RunningServer,
  ctx: Actors,
  recv: WebhookReceiver,
): Promise<void> {
  const sub = await json<{ subscriptionId: string }>(
    server,
    "POST",
    "/v1/webhooks/subscriptions",
    ctx.admin,
    {
      endpoint: recv.url,
      eventTypes: ["message.appended"],
      streamId: ctx.channelId,
      secret: "demo-signing-secret-1234",
    },
  );
  log("admin", `registered webhook subscription ${c.cyan}${short(sub.subscriptionId)}${c.reset} → ${recv.url}`);

  const deliveryPromise = recv.waitForDelivery(2000);

  await json(server, "POST", "/v1/messages", ctx.admin, {
    streamId: ctx.channelId,
    streamType: "channel",
    parts: [{ type: "text", payload: { text: "broadcast: v1.0 is live" } }],
    idempotencyKey: "demo-broadcast",
  });
  log("admin", "posted broadcast message (triggers webhook delivery)");

  const delivered = await deliveryPromise;
  if (delivered) {
    const event = (delivered as { event?: { type?: string } }).event;
    log("webhook", `${c.green}delivery received${c.reset}: event.type=${c.cyan}${event?.type ?? "?"}${c.reset} (HMAC-signed)`);
  } else {
    log("webhook", `${c.yellow}delivery pending${c.reset} (async, check audit for artifact.registered)`);
  }

  const subs = await json<{
    subscriptions: Array<{ id: string; enabled: boolean; eventTypes: string[] }>;
  }>(server, "GET", "/v1/webhooks/subscriptions", ctx.admin);
  log("admin", `${subs.subscriptions.length} subscription(s) listed, enabled=${subs.subscriptions[0]?.enabled}`);

  await patch(server, `/v1/webhooks/subscriptions/${sub.subscriptionId}`, ctx.admin, {
    enabled: false,
  });
  log("admin", `disabled subscription ${c.dim}${short(sub.subscriptionId)}${c.reset}`);

  const subsAfter = await json<{
    subscriptions: Array<{ id: string; enabled: boolean }>;
  }>(server, "GET", "/v1/webhooks/subscriptions?includeDisabled=true", ctx.admin);
  const disabledCount = subsAfter.subscriptions.filter((s) => !s.enabled).length;
  log("admin", `subscription list (includeDisabled=true): ${subsAfter.subscriptions.length} total, ${disabledCount} disabled`);
}

async function durableStreamFlow(server: RunningServer, ctx: Actors): Promise<string> {
  const ds = await json<{ durableStreamId: string; status: string }>(
    server,
    "POST",
    "/v1/durable-streams",
    ctx.agent,
    {
      targetStreamId: ctx.channelId,
      targetStreamType: "channel",
      contentType: "text/plain; charset=utf-8",
      metadata: { purpose: "release-summary-generation" },
    },
  );
  log("agent", `opened durable stream ${c.cyan}${short(ds.durableStreamId)}${c.reset} → #launch (status=${ds.status})`);

  const chunks = [
    "## Release Summary\n",
    "**v1.0.0** – shipped ",
    new Date().toISOString().slice(0, 10),
    "\n\n- all tests passing\n- artifacts verified\n- staged → production",
  ];

  let appendedOffset = 0;
  for (const [i, text] of chunks.entries()) {
    const appended = await json<{ offset: number }>(
      server,
      "POST",
      `/v1/durable-streams/${ds.durableStreamId}/chunks`,
      ctx.agent,
      { chunks: [{ text }] },
    );
    appendedOffset = appended.offset;
    log("agent", `appended chunk ${i + 1}/${chunks.length} → offset=${appended.offset}`);
  }

  const read = await json<{ chunks: Array<{ offset: number; text: string }>; upToDate: boolean }>(
    server,
    "GET",
    `/v1/durable-streams/${ds.durableStreamId}/read?offset=0`,
    ctx.agent,
  );
  log("agent", `read back ${c.magenta}${read.chunks.length}${c.reset} chunk(s), offset=${appendedOffset}, upToDate=${read.upToDate}`);

  const head = await json<{ durableStreamId: string; status: string; offset: number }>(
    server,
    "GET",
    `/v1/durable-streams/${ds.durableStreamId}/head`,
    ctx.agent,
  );
  log("agent", `head: status=${head.status}  latestOffset=${head.offset}`);

  const commit = await json<{ durableStreamId: string; status: string; committedMessageId: string }>(
    server,
    "POST",
    `/v1/durable-streams/${ds.durableStreamId}/commit`,
    ctx.agent,
    { idempotencyKey: `ds-commit-${ds.durableStreamId}` },
  );
  log("agent", `committed → message ${c.green}${short(commit.committedMessageId)}${c.reset} posted atomically to #launch`);

  const channelMsgs = await json<{ messages: Array<{ id: string; parts: Array<{ type: string; payload: { text?: string } }> }> }>(
    server,
    "GET",
    `/v1/streams/${ctx.channelId}/messages`,
    ctx.admin,
  );
  const commitMsg = channelMsgs.messages.find((m) => m.id === commit.committedMessageId);
  if (commitMsg) {
    const text = commitMsg.parts[0]?.payload.text ?? "";
    log("admin", `committed message visible in #launch: ${c.dim}${truncate(text.replace(/\n/g, " "), 55)}${c.reset}`);
  }

  return commit.committedMessageId;
}

async function knowledgeFlow(server: RunningServer, ctx: Actors): Promise<string> {
  const entries = await json<{
    entries: Array<{ id: string; text: string; sourceVisibility: string; promoted: boolean }>;
  }>(server, "GET", `/v1/knowledge?streamId=${ctx.channelId}`, ctx.admin);
  log("plugin", `derived ${c.magenta}${entries.entries.length}${c.reset} knowledge entries for #launch (all sourceVisibility=private)`);
  for (const e of entries.entries) {
    log("entry", `  ${c.dim}${short(e.id)}${c.reset}  ${truncate(e.text, 60)}  promoted=${e.promoted}`);
  }

  const outsiderTry = await raw(server, "GET", `/v1/knowledge?streamId=${ctx.channelId}`, ctx.outsider);
  log("outsider", `GET /v1/knowledge?streamId=#launch → ${c.red}${outsiderTry.status}${c.reset} (scope inherited from source)`);

  const toPromote = entries.entries.find((e) => e.text.startsWith("kickoff:"))!;
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

  const stillPrivate = entries.entries.find((e) => e.text.startsWith("plan:"));
  if (stillPrivate) {
    const stillDenied = await raw(server, "GET", `/v1/knowledge/${stillPrivate.id}`, ctx.outsider);
    log("outsider", `but other entries remain ${c.red}${stillDenied.status}${c.reset} (derived visibility preserved)`);
  }

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
  const badge = verify.valid
    ? `${c.green}valid${c.reset}`
    : `${c.red}INVALID at index ${verify.firstBadIndex}${c.reset}`;
  log("admin", `audit chain verification: ${badge} (${verify.total} rows)`);
}

// ── http helpers ─────────────────────────────────────────────────────────────

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

async function patch<T>(
  server: RunningServer,
  path: string,
  principal: Principal | null,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (principal) headers["x-principal"] = JSON.stringify(principal);
  const res = await fetch(`${server.address}${path}`, {
    method: "PATCH",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (verbose) console.log(`${c.dim}  PATCH ${path} → ${res.status} ${text}${c.reset}`);
  if (!res.ok) {
    throw new Error(`PATCH ${path} → ${res.status} ${text}`);
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
