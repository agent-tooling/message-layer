import WebSocket from "ws";
import { bootstrapAgent } from "./bootstrap.js";
import { CursorApiClient, type AgentStatus } from "./cursor-api.js";
import { MessageLayerClient, type MlMessage, type Principal } from "./ml.js";

const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.baseUrl ?? process.env.MESSAGE_LAYER_BASE_URL ?? "http://127.0.0.1:3000";
const HEALTH_URL = args.healthUrl ?? process.env.NEXTJS_HEALTH_URL ?? "http://localhost:3001";
const ORG_ID = args.orgId ?? process.env.MESSAGE_LAYER_ORG_ID ?? "";
const CURSOR_API_KEY = process.env.CURSOR_API_KEY ?? "";
const DEFAULT_REPOSITORY = process.env.CURSOR_DEFAULT_REPOSITORY ?? "";
const DEFAULT_REF = process.env.CURSOR_DEFAULT_REF ?? "main";
const ONCE = args.once;

type CursorInvocation = {
  runId: string;
  streamType: "thread" | "channel";
  prompt: string;
  requesterActorId: string | null;
  repository: string | null;
  ref: string | null;
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
  return url.protocol === "https:"
    ? url.toString().replace(/^https:/, "wss:")
    : url.toString().replace(/^http:/, "ws:");
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
    const repository =
      typeof argsRecord.repository === "string" && argsRecord.repository.length > 0
        ? argsRecord.repository
        : null;
    const ref =
      typeof argsRecord.ref === "string" && argsRecord.ref.length > 0
        ? argsRecord.ref
        : null;
    if (!runId || !prompt) continue;
    return { runId, streamType, prompt, requesterActorId, repository, ref };
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

function statusEmoji(status: AgentStatus): string {
  switch (status) {
    case "FINISHED": return "✅";
    case "FAILED":   return "❌";
    case "STOPPED":  return "⏹";
    default:         return "⏳";
  }
}

async function handleInvocation(
  cursorApi: CursorApiClient,
  client: MessageLayerClient,
  selfActorId: string,
  streamId: string,
  invocation: CursorInvocation,
): Promise<void> {
  const repository = invocation.repository ?? DEFAULT_REPOSITORY;
  const ref = invocation.ref ?? DEFAULT_REF;

  if (!repository) {
    await client.appendParts({
      streamId,
      streamType: invocation.streamType,
      parts: [
        {
          type: "text",
          payload: {
            text: "Cannot launch Cursor agent: no repository provided. Set `CURSOR_DEFAULT_REPOSITORY` or pass `repository` in the invocation args.",
            kind: "cursor_error",
          },
        },
      ],
    });
    return;
  }

  // Post "launching" acknowledgement
  const ack = await client.appendParts({
    streamId,
    streamType: invocation.streamType,
    parts: [
      {
        type: "text",
        payload: {
          text: `Launching Cursor cloud agent for run \`${invocation.runId.slice(0, 8)}\`…`,
          kind: "cursor_status",
        },
      },
      {
        type: "tool_result",
        payload: {
          toolName: "cursor.invoke",
          content: JSON.stringify({ runId: invocation.runId, status: "launching" }, null, 2),
        },
      },
    ],
  });
  if (!ack.ok) {
    console.warn(`[cursor] failed to write ack for ${invocation.runId}: ${ack.message}`);
    return;
  }

  let agentId: string;
  let agentUrl: string | undefined;
  try {
    const launched = await cursorApi.launchAgent({
      prompt: { text: invocation.prompt },
      source: { repository, ref },
      target: { autoCreatePr: false },
    });
    agentId = launched.id;
    agentUrl = launched.target?.url;
    console.log(`[cursor] launched agent ${agentId} for run ${invocation.runId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cursor] failed to launch agent: ${msg}`);
    await client.appendParts({
      streamId,
      streamType: invocation.streamType,
      parts: [
        {
          type: "text",
          payload: { text: `Failed to launch Cursor agent: ${msg}`, kind: "cursor_error" },
        },
        {
          type: "tool_result",
          payload: {
            toolName: "cursor.invoke",
            content: JSON.stringify({ runId: invocation.runId, status: "failed", error: msg }, null, 2),
          },
        },
      ],
    });
    return;
  }

  // Post "agent started" with link
  const startedLines = [`Cursor agent \`${agentId}\` is running.`];
  if (agentUrl) startedLines.push(`[View agent](${agentUrl})`);
  await client.appendParts({
    streamId,
    streamType: invocation.streamType,
    parts: [
      {
        type: "text",
        payload: { text: startedLines.join("\n"), kind: "cursor_status" },
      },
    ],
  });

  // Poll until terminal state
  let finalAgent: Awaited<ReturnType<CursorApiClient["waitForTerminal"]>>;
  try {
    finalAgent = await cursorApi.waitForTerminal(agentId, { pollMs: 5000 });
    console.log(`[cursor] agent ${agentId} finished with status ${finalAgent.status}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cursor] agent ${agentId} error during polling: ${msg}`);
    await client.appendParts({
      streamId,
      streamType: invocation.streamType,
      parts: [
        {
          type: "text",
          payload: { text: `Cursor agent error: ${msg}`, kind: "cursor_error" },
        },
        {
          type: "tool_result",
          payload: {
            toolName: "cursor.invoke",
            content: JSON.stringify({ runId: invocation.runId, agentId, status: "error", error: msg }, null, 2),
          },
        },
      ],
    });
    return;
  }

  const emoji = statusEmoji(finalAgent.status);
  const resultLines: string[] = [
    `${emoji} Cursor agent \`${agentId}\` ${finalAgent.status.toLowerCase()}.`,
  ];
  if (finalAgent.summary) {
    resultLines.push("", finalAgent.summary);
  }
  if (finalAgent.target?.prUrl) {
    resultLines.push("", `[View pull request](${finalAgent.target.prUrl})`);
  } else if (agentUrl) {
    resultLines.push("", `[View agent](${agentUrl})`);
  }

  const resultParts: Array<{ type: "text" | "tool_result"; payload: Record<string, unknown> }> = [
    {
      type: "text",
      payload: { text: resultLines.join("\n") },
    },
    {
      type: "tool_result",
      payload: {
        toolName: "cursor.invoke",
        content: JSON.stringify(
          {
            runId: invocation.runId,
            agentId,
            status: finalAgent.status.toLowerCase(),
            summary: finalAgent.summary ?? null,
            prUrl: finalAgent.target?.prUrl ?? null,
            agentUrl: agentUrl ?? null,
            responderActorId: selfActorId,
          },
          null,
          2,
        ),
      },
    },
  ];

  const posted = await client.appendParts({
    streamId,
    streamType: invocation.streamType,
    parts: resultParts,
  });
  if (!posted.ok) {
    console.warn(`[cursor] failed to post completion for ${invocation.runId}: ${posted.message}`);
  }
}

async function run(): Promise<void> {
  if (!CURSOR_API_KEY) {
    throw new Error("CURSOR_API_KEY is required");
  }
  if (!ORG_ID) {
    throw new Error("MESSAGE_LAYER_ORG_ID (or --org-id) is required");
  }
  if (!(await isNextjsUp())) {
    throw new Error(`Next.js at ${HEALTH_URL} is not responding`);
  }

  const cursorApi = new CursorApiClient(CURSOR_API_KEY);

  // Verify the API key works
  try {
    const me = await cursorApi.getMe();
    console.log(`[cursor] authenticated as ${me.userEmail} (key: ${me.apiKeyName})`);
  } catch (err) {
    throw new Error(`Cursor API key check failed: ${err instanceof Error ? err.message : String(err)}`);
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

        await handleInvocation(cursorApi, client, principal.actorId, targetStreamId, invocation);
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
