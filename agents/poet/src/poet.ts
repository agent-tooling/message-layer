import { Agent } from "@mastra/core/agent";
import { bootstrapAgent } from "./bootstrap.js";
import { MessageLayerClient } from "./ml.js";

const args = parseArgs(process.argv.slice(2));

const BASE_URL = args.baseUrl ?? process.env.MESSAGE_LAYER_BASE_URL ?? "http://127.0.0.1:3000";
const HEALTH_URL = args.healthUrl ?? process.env.NEXTJS_HEALTH_URL ?? "http://localhost:3001";
const ORG_ID = args.orgId ?? process.env.MESSAGE_LAYER_ORG_ID ?? "";
const INTERVAL_MS = Number(args.intervalMs ?? process.env.POET_INTERVAL_MS ?? "60000");
const MODEL = args.model ?? process.env.POET_MODEL ?? "openai/gpt-4o-mini";
const ONCE = args.once;
const POEMS_CHANNEL_NAME = "poems";

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
  if (args.help) {
    printUsage();
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      `${colors.red}✗ OPENAI_API_KEY is not set. Export it (or copy .env.example → .env) and try again.${colors.reset}`,
    );
    process.exitCode = 1;
    return;
  }
  if (!ORG_ID) {
    console.error(
      `${colors.red}✗ missing org id. Pass it as \`--org-id <id>\` or export MESSAGE_LAYER_ORG_ID.${colors.reset}\n` +
        `  Look it up from the Next.js client with:\n` +
        `    sqlite3 clients/nextjs/.data/team-client.db "select value from app_settings where key='default_org_id'"`,
    );
    process.exitCode = 1;
    return;
  }

  logHeader("poet boot");
  log("env", `message-layer ${colors.cyan}${BASE_URL}${colors.reset}`);
  log("env", `next.js      ${colors.cyan}${HEALTH_URL}${colors.reset}`);
  log("env", `org id       ${colors.magenta}${ORG_ID}${colors.reset}`);
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
    appUrl: HEALTH_URL,
    orgId: ORG_ID,
    displayName: "poet-agent",
  });
  log("bootstrap", `${reused ? "reusing" : "created"} agent actor ${colors.magenta}${principal.actorId}${colors.reset} in org ${colors.magenta}${principal.orgId}${colors.reset}`);
  log("bootstrap", `${colors.dim}scopes=[]${colors.reset} — permission flow should kick in on first use`);

  const scopedClient = new MessageLayerClient(BASE_URL, principal);

  const agent = new Agent({
    id: "poet",
    name: "Poet",
    instructions: `You are a concise, slightly playful poet.
Generate a fresh 2-4 line original poem (max 220 chars) about software agents,
coordination, time, or curiosity. Return only the poem text with line breaks.
No intro sentence, no markdown fences.`,
    model: MODEL,
  });

  const commandRegistration = await scopedClient.registerCommand({
    name: "poem",
    description: "Ask the poet agent for a short poem reply in a thread.",
    argsSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Optional topic or prompt" },
      },
    },
  });
  if (commandRegistration.ok) {
    log(
      "command",
      `registered /poem (commandId=${commandRegistration.commandId}, request=${commandRegistration.requestId})`,
    );
  } else {
    log(
      "command",
      `${colors.yellow}could not register /poem yet: ${commandRegistration.message}${colors.reset}`,
    );
  }

  const lastSeqByStream = new Map<string, number>();
  const seenInvocationKeys = new Set<string>();

  let tick = 0;
  for (;;) {
    tick += 1;
    logHeader(`tick ${tick} — ${ts()}`);

    if (!(await isNextjsUp())) {
      log("gate", `${colors.red}Next.js at ${HEALTH_URL} is down; halting loop to avoid token burn${colors.reset}`);
      break;
    }

    try {
      const channels = await scopedClient.listChannels();

      // Autonomous behavior: post a fresh poem into #poems every tick.
      const poemsChannelId = await ensurePoemsChannel(scopedClient, channels);
      if (poemsChannelId) {
        const periodicPoem = await generatePoemText(agent, "");
        const periodicPost = await scopedClient.appendMessage({
          streamId: poemsChannelId,
          streamType: "channel",
          text: periodicPoem,
        });
        if (periodicPost.ok) {
          log(
            "poems",
            `${colors.green}posted periodic poem to #${POEMS_CHANNEL_NAME} (message ${periodicPost.messageId.slice(0, 8)})${colors.reset}`,
          );
        } else {
          const reqHint = periodicPost.requestId ? ` request=${periodicPost.requestId}` : "";
          log(
            "poems",
            `${colors.yellow}could not post periodic poem: ${periodicPost.message}${reqHint}${colors.reset}`,
          );
        }
      }

      for (const channel of channels) {
        const streamIds = [channel.id];
        try {
          const threads = await scopedClient.listThreads(channel.id);
          for (const thread of threads) streamIds.push(thread.id);
        } catch (error) {
          log(
            "poem",
            `${colors.yellow}could not list threads for #${channel.name}: ${error instanceof Error ? error.message : String(error)}${colors.reset}`,
          );
        }
        for (const streamId of streamIds) {
          const fromSeq = lastSeqByStream.get(streamId) ?? 0;
          const events = await scopedClient.listStreamEvents(streamId, fromSeq);
          let maxSeq = fromSeq;
          for (const event of events) {
            if (typeof event.streamSeq === "number") {
              maxSeq = Math.max(maxSeq, event.streamSeq);
            }
            if (event.type !== "command.invoked") continue;
            const command = typeof event.payload.command === "string" ? event.payload.command : "";
            if (!isPoemCommand(command)) continue;
            const ownerActorId = typeof event.payload.ownerActorId === "string" ? event.payload.ownerActorId : null;
            if (ownerActorId && ownerActorId !== principal.actorId) continue;
            const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : "";
            const partIndex = typeof event.payload.partIndex === "number" ? event.payload.partIndex : -1;
            const streamType =
              event.payload.streamType === "thread" ? "thread" : "channel";
            const eventStreamId = typeof event.payload.streamId === "string" ? event.payload.streamId : streamId;
            if (!messageId || partIndex < 0) continue;
            const key = `${messageId}:${partIndex}`;
            if (seenInvocationKeys.has(key)) continue;
            seenInvocationKeys.add(key);

            const prompt = await resolvePromptFromCommandPart({
              client: scopedClient,
              streamId: eventStreamId,
              messageId,
              streamSeq:
                typeof event.payload.streamSeq === "number"
                  ? event.payload.streamSeq
                  : event.streamSeq ?? 0,
              partIndex,
            });
            const poemText = await generatePoemText(agent, prompt);
            const replyResult = await postPoemReply({
              client: scopedClient,
              streamType,
              channelId: channel.id,
              parentMessageId: messageId,
              targetThreadId: streamType === "thread" ? eventStreamId : null,
              text: poemText,
            });
            if (replyResult.ok) {
              log(
                "poem",
                `${colors.green}replied to /${command} in ${streamType} ${eventStreamId.slice(0, 8)} (message ${replyResult.messageId.slice(0, 8)})${colors.reset}`,
              );
            } else {
              const reqHint = replyResult.requestId
                ? ` request=${replyResult.requestId}`
                : "";
              log(
                "poem",
                `${colors.yellow}could not reply: ${replyResult.message}${reqHint}${colors.reset}`,
              );
              if (
                replyResult.requestId &&
                replyResult.message.includes("still pending admin approval")
              ) {
                // Keep the invocation eligible for a later retry once approval lands.
                seenInvocationKeys.delete(key);
              }
            }
          }
          lastSeqByStream.set(streamId, maxSeq);
        }
      }
    } catch (error) {
      log("error", `${colors.red}${error instanceof Error ? error.message : String(error)}${colors.reset}`);
    }

    if (ONCE) break;
    log("sleep", `${colors.dim}waiting ${INTERVAL_MS}ms${colors.reset}`);
    await sleep(INTERVAL_MS);
  }
}

async function ensurePoemsChannel(
  client: MessageLayerClient,
  channels: Array<{ id: string; name: string }>,
): Promise<string | null> {
  const existing = channels.find((channel) => channel.name === POEMS_CHANNEL_NAME);
  if (existing) return existing.id;
  const created = await client.createChannel(POEMS_CHANNEL_NAME, "public");
  if (created.ok) return created.channelId;
  const reqHint = created.requestId ? ` request=${created.requestId}` : "";
  log(
    "poems",
    `${colors.yellow}could not create #${POEMS_CHANNEL_NAME}: ${created.message}${reqHint}${colors.reset}`,
  );
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPoemCommand(command: string): boolean {
  if (!command) return false;
  const lower = command.toLowerCase();
  if (lower === "poem") return true;
  return lower.endsWith(":poem");
}

async function resolvePromptFromCommandPart(input: {
  client: MessageLayerClient;
  streamId: string;
  messageId: string;
  streamSeq: number;
  partIndex: number;
}): Promise<string> {
  const afterSeq = Math.max(0, input.streamSeq - 1);
  const messages = await input.client.listMessages(input.streamId, afterSeq);
  const message = messages.find((m) => m.id === input.messageId);
  if (!message) return "";
  const commandPart = message.parts[input.partIndex];
  if (!commandPart || commandPart.type !== "command") return "";
  const args = commandPart.payload.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const maybeText = (args as { text?: unknown }).text;
  if (typeof maybeText !== "string") return "";
  return maybeText.trim();
}

async function generatePoemText(agent: Agent, prompt: string): Promise<string> {
  const request = prompt.length > 0
    ? `Write a short poem about: ${prompt}`
    : "Write a short poem for the current thread.";
  const response = await agent.generate(request);
  const text = response.text?.trim() ?? "";
  if (text.length > 0) return text;
  return "Quiet bots wait,\nclockwork thoughts drift through the wire—\nnight hums in code.";
}

async function postPoemReply(input: {
  client: MessageLayerClient;
  streamType: "channel" | "thread";
  channelId: string;
  parentMessageId: string;
  targetThreadId: string | null;
  text: string;
}): Promise<
  | { ok: true; messageId: string }
  | { ok: false; message: string; requestId?: string }
> {
  let threadId = input.targetThreadId;
  if (input.streamType === "channel") {
    const created = await input.client.createThread(
      input.channelId,
      input.parentMessageId,
      "public",
    );
    if (!created.ok) {
      return {
        ok: false,
        message: created.message,
        requestId: created.requestId,
      };
    }
    threadId = created.threadId;
  }
  if (!threadId) {
    return { ok: false, message: "missing target thread id" };
  }
  const appended = await input.client.appendMessage({
    streamId: threadId,
    streamType: "thread",
    text: input.text,
  });
  if (!appended.ok) {
    return {
      ok: false,
      message: appended.message,
      requestId: appended.requestId,
    };
  }
  return { ok: true, messageId: appended.messageId };
}

type ParsedArgs = {
  help: boolean;
  once: boolean;
  orgId?: string;
  baseUrl?: string;
  healthUrl?: string;
  intervalMs?: string;
  model?: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, once: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eat = (): string | undefined => {
      const eq = arg.indexOf("=");
      if (eq !== -1) return arg.slice(eq + 1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return undefined;
      i += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--once") out.once = true;
    else if (arg === "--org-id" || arg === "--org" || arg.startsWith("--org-id=") || arg.startsWith("--org=")) out.orgId = eat();
    else if (arg === "--base-url" || arg.startsWith("--base-url=")) out.baseUrl = eat();
    else if (arg === "--health-url" || arg.startsWith("--health-url=")) out.healthUrl = eat();
    else if (arg === "--interval-ms" || arg.startsWith("--interval-ms=")) out.intervalMs = eat();
    else if (arg === "--model" || arg.startsWith("--model=")) out.model = eat();
  }
  return out;
}

function printUsage(): void {
  console.log(`poet agent — a Mastra loop that writes poems into #poems

Usage:
  pnpm start --org-id <orgId> [flags]
  pnpm run once --org-id <orgId>                 # single tick, exit

Flags:
  --org-id <id>         Org the agent should join (required; or MESSAGE_LAYER_ORG_ID)
  --base-url <url>      message-layer base URL (default: http://127.0.0.1:3000)
  --health-url <url>    Next.js health URL    (default: http://localhost:3001)
  --interval-ms <ms>    tick cadence          (default: 60000)
  --model <id>          Mastra model id       (default: openai/gpt-4o-mini)
  --once                run a single tick and exit
  -h, --help            show this message

Environment (used when the flag is not passed):
  OPENAI_API_KEY         required
  MESSAGE_LAYER_ORG_ID   required unless --org-id is passed
  MESSAGE_LAYER_BASE_URL
  NEXTJS_HEALTH_URL
  POET_INTERVAL_MS
  POET_MODEL

Find the current default org id with:
  sqlite3 clients/nextjs/.data/team-client.db "select value from app_settings where key='default_org_id'"
`);
}

void main();
