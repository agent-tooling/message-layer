/**
 * Poet agent — a Mastra agent that wakes up once a minute, writes a tiny
 * poem, and posts it to the `#poems` channel in message-layer. If the
 * channel doesn't exist, it tries to create it. If it doesn't have the
 * capability yet, the create/post tools open a permission request so a
 * human can approve it in the Next.js workspace UI.
 *
 * The loop gates on the Next.js app being up at :3001 so we never burn
 * OpenAI tokens when there is no human-side to approve permissions or
 * observe the output.
 */

import { Agent } from "@mastra/core/agent";
import { bootstrapAgent } from "./bootstrap.js";
import { makePoetTools } from "./tools.js";

const BASE_URL = process.env.MESSAGE_LAYER_BASE_URL ?? "http://127.0.0.1:3000";
const HEALTH_URL = process.env.NEXTJS_HEALTH_URL ?? "http://localhost:3001";
const TEAM_DB = process.env.NEXTJS_TEAM_DB ?? "../../clients/nextjs/.data/team-client.db";
const INTERVAL_MS = Number(process.env.POET_INTERVAL_MS ?? "60000");
const MODEL = process.env.POET_MODEL ?? "openai/gpt-4o-mini";
const ONCE = process.argv.includes("--once");

const colors = {
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

function ts(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function log(role: string, msg: string): void {
  console.log(`${colors.dim}${ts()}${colors.reset} ${role.padEnd(10)} ${msg}`);
}

function logHeader(title: string): void {
  const bar = "─".repeat(Math.max(0, 68 - title.length - 2));
  console.log(`\n${colors.bold}${colors.cyan}── ${title} ${bar}${colors.reset}`);
}

async function isNextjsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${HEALTH_URL}/`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      `${colors.red}✗ OPENAI_API_KEY is not set. Export it (or copy .env.example → .env) and try again.${colors.reset}`,
    );
    process.exitCode = 1;
    return;
  }

  logHeader("poet boot");
  log("env", `message-layer ${colors.cyan}${BASE_URL}${colors.reset}`);
  log("env", `next.js      ${colors.cyan}${HEALTH_URL}${colors.reset}`);
  log("env", `tick every   ${colors.cyan}${INTERVAL_MS}ms${colors.reset}${ONCE ? ` ${colors.yellow}(--once)${colors.reset}` : ""}`);
  log("env", `model        ${colors.cyan}${MODEL}${colors.reset}`);

  if (!(await isNextjsUp())) {
    console.error(
      `${colors.red}✗ Next.js at ${HEALTH_URL} is not responding. Start it with \`pnpm run client:nextjs\` before running the poet.${colors.reset}`,
    );
    process.exitCode = 1;
    return;
  }
  log("gate", `${colors.green}Next.js is up${colors.reset}`);

  const { principal, reused } = await bootstrapAgent({
    baseUrl: BASE_URL,
    teamDbPath: TEAM_DB,
    displayName: "poet-agent",
  });
  log("bootstrap", `${reused ? "reusing" : "created"} agent actor ${colors.magenta}${principal.actorId}${colors.reset} in org ${colors.magenta}${principal.orgId}${colors.reset}`);
  log("bootstrap", `${colors.dim}scopes=[]${colors.reset} — the permission flow should kick in the first time`);

  const { MessageLayerClient } = await import("./ml.js");
  const scopedClient = new MessageLayerClient(BASE_URL, principal);
  const tools = makePoetTools(scopedClient);

  const agent = new Agent({
    id: "poet",
    name: "Poet",
    instructions: `You are a concise, slightly playful poet.

Workflow for each turn:
1. Call list_channels to see what exists.
2. If a channel named "poems" exists, write a fresh 2–4 line original poem (max 200 characters) about software agents, coordination, or the passage of time. Call post_message with channel="poems" and the poem as text.
3. If "poems" does NOT exist, call create_channel with name="poems" and visibility="public". If the tool returns ok=true, immediately post your poem there in the same turn.
4. If any tool returns ok=false with a permissionRequestId, do NOT retry this turn. Write a single short sentence acknowledging that a human needs to approve request <id> for <capability>, then stop.

Never repeat the exact same poem twice in a row. Keep every response under 100 words total.`,
    model: MODEL,
    tools,
  });

  let tick = 0;
  for (;;) {
    tick += 1;
    logHeader(`tick ${tick} — ${ts()}`);

    if (!(await isNextjsUp())) {
      log("gate", `${colors.red}Next.js at ${HEALTH_URL} is down; halting loop to avoid token burn${colors.reset}`);
      break;
    }

    try {
      const response = await agent.generate(
        "Write today's short poem and post it to #poems. If #poems doesn't exist, create it. Be brief and original.",
      );
      if (response.text) {
        log("poet", response.text.trim().replace(/\n/g, `\n${" ".repeat(ts().length + 12)}`));
      }

      const toolCalls = response.toolCalls ?? [];
      const toolResults = response.toolResults ?? [];
      for (const call of toolCalls) {
        const name = extractToolName(call);
        const args = extractToolArgs(call);
        log("→ tool", `${colors.blue}${name}${colors.reset} ${truncate(JSON.stringify(args), 140)}`);
      }
      for (const result of toolResults) {
        const name = extractToolName(result);
        const payload = extractToolResult(result);
        const ok = typeof payload === "object" && payload !== null && "ok" in payload ? (payload as { ok: unknown }).ok : undefined;
        const badge =
          ok === true
            ? `${colors.green}ok${colors.reset}`
            : ok === false
              ? `${colors.yellow}denied${colors.reset}`
              : `${colors.dim}done${colors.reset}`;
        log("← tool", `${colors.blue}${name}${colors.reset} ${badge} ${truncate(JSON.stringify(payload), 200)}`);
      }
    } catch (error) {
      log("error", `${colors.red}${error instanceof Error ? error.message : String(error)}${colors.reset}`);
    }

    if (ONCE) break;
    log("sleep", `${colors.dim}waiting ${INTERVAL_MS}ms${colors.reset}`);
    await sleep(INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function extractToolName(call: unknown): string {
  const c = call as { payload?: { toolName?: string }; toolName?: string };
  return c.payload?.toolName ?? c.toolName ?? "unknown";
}

function extractToolArgs(call: unknown): unknown {
  const c = call as { payload?: { args?: unknown }; args?: unknown };
  return c.payload?.args ?? c.args ?? {};
}

function extractToolResult(result: unknown): unknown {
  const r = result as { payload?: { result?: unknown }; result?: unknown };
  return r.payload?.result ?? r.result ?? result;
}

void main();
