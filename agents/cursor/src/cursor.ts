import { Agent } from "@mastra/core/agent";
import WebSocket from "ws";
import { bootstrapAgent } from "./bootstrap.js";
import { MessageLayerClient, type MlMessage, type Principal } from "./ml.js";

const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.baseUrl ?? process.env.MESSAGE_LAYER_BASE_URL ?? "http://127.0.0.1:3000";
const HEALTH_URL = args.healthUrl ?? process.env.NEXTJS_HEALTH_URL ?? "http://localhost:3001";
const ORG_ID = args.orgId ?? process.env.MESSAGE_LAYER_ORG_ID ?? "";
const MODEL = args.model ?? process.env.CURSOR_MODEL ?? "openai/gpt-4o-mini";
const ONCE = args.once;

type CursorInvocation = {
  runId: string;
  streamType: "thread" | "channel";
  prompt: string;
  requesterActorId: string | null;
};

async function isNextjsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${HEALTH_URL}/`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function toWsUrl(baseUrl: string): string {
  const url = new URL("/v1/ws", baseUrl);
  return url.protocol === "https:" ? url.toString().replace(/^https:/, "wss:") : url.toString().replace(/^http:/, "ws:");
}

function extractInvocation(msg: MlMessage): CursorInvocation | null {
  for (const part of msg.parts) {
    if (part.type !== "tool_call") continue;
    const toolName = String(part.payload.toolName ?? "");
    if (toolName !== "cursor.invoke") continue;
    const argsRecord = (part.payload.args ?? {}) as Record<string, unknown>;
    const runId = String(argsRecord.runId ?? "").trim();
    const streamType = argsRecord.streamType === "channel" ? "channel" : "thread";
    const prompt = String(argsRecord.prompt ?? "").trim();
    const requesterActorId =
      typeof argsRecord.requesterActorId === "string" && argsRecord.requesterActorId.length > 0
        ? argsRecord.requesterActorId
        : null;
    if (!runId || !prompt) continue;
    return { runId, streamType, prompt, requesterActorId };
  }
  return null;
}

function parseFrame(raw: WebSocket.RawData): {
  type: string;
  lastSeq?: number;
  streamId?: string;
  event?: { type?: string; streamId?: string; streamSeq?: number };
  error?: string;
} | null {
  try {
    return JSON.parse(raw.toString()) as {
      type: string;
      lastSeq?: number;
      streamId?: string;
      event?: { type?: string; streamId?: string; streamSeq?: number };
      error?: string;
    };
  } catch {
    return null;
  }
}

async function handleInvocation(
  agent: Agent,
  client: MessageLayerClient,
  selfActorId: string,
  streamId: string,
  invocation: CursorInvocation,
): Promise<void> {
  const start = await client.appendParts({
    streamId,
    streamType: invocation.streamType,
    parts: [
      {
        type: "text",
        payload: {
          text: `Cursor run ${invocation.runId.slice(0, 8)} started.`,
          kind: "cursor_status",
        },
      },
      {
        type: "tool_result",
        payload: {
          toolName: "cursor.invoke",
          content: JSON.stringify(
            {
              runId: invocation.runId,
              status: "started",
              streamType: invocation.streamType,
            },
            null,
            2,
          ),
        },
      },
    ],
  });
  if (!start.ok) {
    console.warn(`[cursor] failed to write run start for ${invocation.runId}: ${start.message}`);
    return;
  }

  const response = await agent.generate(
    [
      "You are Cursor, a concise coding assistant in message-layer.",
      `User actor id: ${invocation.requesterActorId ?? "unknown"}`,
      `Run id: ${invocation.runId}`,
      `Respond to the user's request in 4-8 short sentences.`,
      "Prefer concrete implementation guidance over generic advice.",
      `User request:\n${invocation.prompt}`,
    ].join("\n\n"),
  );

  const finalText = typeof response.text === "string" ? response.text.trim() : "";
  const parts: Array<{
    type: "text" | "tool_result";
    payload: Record<string, unknown>;
  }> = [];
  if (finalText.length > 0) {
    parts.push({ type: "text", payload: { text: finalText } });
  }
  parts.push({
    type: "tool_result",
    payload: {
      toolName: "cursor.invoke",
      content: JSON.stringify(
        {
          runId: invocation.runId,
          status: "completed",
          responderActorId: selfActorId,
        },
        null,
        2,
      ),
    },
  });

  const posted = await client.appendParts({
    streamId,
    streamType: invocation.streamType,
    parts,
  });
  if (!posted.ok) {
    console.warn(`[cursor] failed to post completion for ${invocation.runId}: ${posted.message}`);
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
    displayName: "cursor-agent",
    provider: "cursor-agent",
    statePrefix: "cursor",
  });
  const client = new MessageLayerClient(BASE_URL, principal);
  const modelAgent = new Agent({
    id: "cursor-agent",
    name: "Cursor Agent",
    model: MODEL,
    instructions:
      "You are Cursor. Be direct, implementation-oriented, and keep responses compact unless asked for deep detail.",
  });

  const channels = await client.listChannels();
  if (channels.length === 0) {
    throw new Error("No channels visible to cursor-agent.");
  }

  const ws = new WebSocket(toWsUrl(BASE_URL), {
    headers: { "x-principal": JSON.stringify(principal) },
  });
  const channelLastSeq = new Map<string, number>();
  const processed = new Set<string>();
  let handled = 0;
  let ready = false;

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      for (const channel of channels) {
        ws.send(
          JSON.stringify({
            type: "subscribe",
            streamId: channel.id,
            streamType: "channel",
            fromSeq: 0,
          }),
        );
      }
      ready = true;
    });

    ws.on("message", async (raw) => {
      if (!ready) return;
      const frame = parseFrame(raw);
      if (!frame) return;
      if (frame.type === "subscribed" && frame.streamId) {
        channelLastSeq.set(frame.streamId, Math.max(channelLastSeq.get(frame.streamId) ?? 0, frame.lastSeq ?? 0));
        return;
      }
      if (frame.type === "error") {
        reject(new Error(frame.error ?? "websocket error"));
        return;
      }
      if (frame.type !== "event") return;
      if (frame.event?.type !== "message.appended") return;
      const channelId = frame.event.streamId ?? null;
      const seq = typeof frame.event.streamSeq === "number" ? frame.event.streamSeq : null;
      if (!channelId || seq === null) return;

      const last = channelLastSeq.get(channelId) ?? 0;
      const messages = await client.listMessages(channelId, Math.max(0, last - 1));
      channelLastSeq.set(channelId, Math.max(last, seq));

      for (const msg of messages) {
        if (msg.streamSeq <= last) continue;
        if (msg.actorId === principal.actorId) continue;
        if (processed.has(msg.id)) continue;
        processed.add(msg.id);

        const invocation = extractInvocation(msg);
        if (!invocation) continue;

        const toolCallPayload = msg.parts.find((part) => part.type === "tool_call")
          ?.payload as Record<string, unknown> | undefined;
        const toolArgs = (toolCallPayload?.args ?? {}) as Record<string, unknown>;
        const targetStreamType = invocation.streamType;
        const targetStreamId =
          targetStreamType === "thread"
            ? String(toolArgs.threadId ?? "").trim()
            : channelId;
        if (!targetStreamId) continue;

        await handleInvocation(modelAgent, client, principal.actorId, targetStreamId, invocation);
        handled += 1;
        if (ONCE && handled >= 1) {
          ws.close(1000, "once complete");
          resolve();
          return;
        }
      }
    });

    ws.on("error", (error) => reject(error));
    ws.on("close", () => {
      if (!ONCE) resolve();
    });
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
  console.log("cursor agent\n\nUsage: pnpm start --org-id <orgId> [--once]");
  process.exit(0);
}

void run().catch((error) => {
  console.error(`[cursor] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
