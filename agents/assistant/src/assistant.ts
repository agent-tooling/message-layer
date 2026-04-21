import { Agent } from "@mastra/core/agent";
import WebSocket from "ws";
import { bootstrapAgent } from "./bootstrap.js";
import { MessageLayerClient, type Principal } from "./ml.js";
import { makeAssistantTools } from "./tools.js";

const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.baseUrl ?? process.env.MESSAGE_LAYER_BASE_URL ?? "http://127.0.0.1:3000";
const HEALTH_URL = args.healthUrl ?? process.env.NEXTJS_HEALTH_URL ?? "http://localhost:3001";
const ORG_ID = args.orgId ?? process.env.MESSAGE_LAYER_ORG_ID ?? "";
const MODEL = args.model ?? process.env.ASSISTANT_MODEL ?? "openai/gpt-4o-mini";
const ONCE = args.once;

async function isNextjsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${HEALTH_URL}/`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureGeneralChannel(client: MessageLayerClient): Promise<string | null> {
  const channels = await client.listChannels();
  const existing = channels.find((c) => c.name === "general");
  if (existing) return existing.id;
  const created = await client.createChannel("general", "public");
  return created.ok ? created.channelId : null;
}

function toWsUrl(baseUrl: string): string {
  const url = new URL("/v1/ws", baseUrl);
  return url.protocol === "https:" ? url.toString().replace(/^https:/, "wss:") : url.toString().replace(/^http:/, "ws:");
}

async function handleIncomingMessage(
  mastraAgent: Agent,
  client: MessageLayerClient,
  channelId: string,
  selfActorId: string,
  streamSeq: number,
): Promise<void> {
  const messages = await client.listMessages(channelId, Math.max(0, streamSeq - 1));
  const msg = messages.find((item) => item.streamSeq === streamSeq);
  if (!msg) return;
  if (msg.actorId === selfActorId) return;
  const textPart = msg.parts.find((part) => part.type === "text");
  const text = typeof textPart?.payload?.text === "string" ? textPart.payload.text : "";
  if (!text.trim()) return;

  const response = await mastraAgent.generate(
    `A user posted in #general: "${text}".
Reply in #general as the assistant.
If you need to create or manage channels, use your tools.
Do not respond if the message is clearly just from yourself or empty.`,
  );
  if (response.text) {
    console.log(`[assistant] ${response.text.trim()}`);
  }
}

async function run(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }
  if (!ORG_ID) {
    throw new Error("MESSAGE_LAYER_ORG_ID (or --org-id) is required");
  }
  if (!(await isNextjsUp())) {
    throw new Error(`Next.js at ${HEALTH_URL} is not responding`);
  }

  const { principal } = await bootstrapAgent({
    baseUrl: BASE_URL,
    appUrl: HEALTH_URL,
    orgId: ORG_ID,
    displayName: "assistant-agent",
  });
  const client = new MessageLayerClient(BASE_URL, principal);
  const tools = makeAssistantTools(client);
  const mastraAgent = new Agent({
    id: "assistant",
    name: "Workspace Assistant",
    model: MODEL,
    instructions: `You are a workspace manager assistant.
Use tools to inspect channels, create channels, and post messages.
When a new user message appears in #general, reply briefly and helpfully.
If a tool returns a permission request id, mention that approval is needed and stop retrying.`,
    tools,
  });

  const generalChannelId = await ensureGeneralChannel(client);
  if (!generalChannelId) {
    throw new Error("Could not find or create #general (likely waiting for permission approval).");
  }
  console.log(`[assistant] subscribing to #general (${generalChannelId})`);
  await subscribeLoop({
    baseUrl: BASE_URL,
    principal,
    channelId: generalChannelId,
    client,
    mastraAgent,
    once: ONCE,
  });
}

async function subscribeLoop(input: {
  baseUrl: string;
  principal: Principal;
  channelId: string;
  client: MessageLayerClient;
  mastraAgent: Agent;
  once: boolean;
}): Promise<void> {
  const wsUrl = toWsUrl(input.baseUrl);
  const ws = new WebSocket(wsUrl, {
    headers: { "x-principal": JSON.stringify(input.principal) },
  });
  let lastSeq = 0;
  let handled = 0;

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          streamId: input.channelId,
          streamType: "channel",
          fromSeq: lastSeq,
        }),
      );
    });

    ws.on("message", async (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as {
          type: string;
          lastSeq?: number;
          event?: { type?: string; streamSeq?: number; payload?: { actorId?: string } };
          error?: string;
        };
        if (frame.type === "subscribed" && typeof frame.lastSeq === "number") {
          lastSeq = Math.max(lastSeq, frame.lastSeq);
          return;
        }
        if (frame.type === "error") {
          reject(new Error(frame.error ?? "websocket subscription failed"));
          return;
        }
        if (frame.type !== "event") return;
        if (frame.event?.type !== "message.appended") return;
        const seq = typeof frame.event.streamSeq === "number" ? frame.event.streamSeq : null;
        if (seq === null) return;
        lastSeq = Math.max(lastSeq, seq);
        await handleIncomingMessage(
          input.mastraAgent,
          input.client,
          input.channelId,
          input.principal.actorId,
          seq,
        );
        handled += 1;
        if (input.once && handled >= 1) {
          ws.close(1000, "once complete");
          resolve();
        }
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    ws.on("close", () => {
      if (!input.once) {
        resolve();
      }
    });
    ws.on("error", (err) => reject(err));
  });
}

type ParsedArgs = {
  help: boolean;
  once: boolean;
  orgId?: string;
  baseUrl?: string;
  healthUrl?: string;
  model?: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, once: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = (): string | undefined => {
      const eq = arg.indexOf("=");
      if (eq !== -1) return arg.slice(eq + 1);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) return undefined;
      i += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--once") out.once = true;
    else if (arg === "--org-id" || arg.startsWith("--org-id=")) out.orgId = readValue();
    else if (arg === "--base-url" || arg.startsWith("--base-url=")) out.baseUrl = readValue();
    else if (arg === "--health-url" || arg.startsWith("--health-url=")) out.healthUrl = readValue();
    else if (arg === "--model" || arg.startsWith("--model=")) out.model = readValue();
  }
  return out;
}

if (args.help) {
  console.log("assistant agent\n\nUsage: pnpm start --org-id <orgId> [--once]");
  process.exit(0);
}

void run().catch((error) => {
  console.error(`[assistant] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
