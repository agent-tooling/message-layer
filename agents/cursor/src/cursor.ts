import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { bootstrapAgent } from "./bootstrap.js";
import { CursorApiClient, type AgentStatus } from "./cursor-api.js";
import { MessageLayerClient, type MlMessage, type Principal } from "./ml.js";

/**
 * The cursor agent is a pure message-layer citizen: it does not expose a
 * bespoke Next.js UI entrypoint or a dedicated HTTP route. Humans invoke it
 * exactly like any other agent in the workspace — by typing the slash
 * command it registered at boot (`/cursor <prompt>`) or by `@`-mentioning
 * the agent actor in a message. The webhook from `message-layer` tells us
 * which happened, we build a prompt from the source message, run the
 * Cursor Cloud Agent, and stream the result back into a new thread
 * anchored on the triggering message.
 */

const args = parseArgs(process.argv.slice(2));
const BASE_URL = args.baseUrl ?? process.env.MESSAGE_LAYER_BASE_URL ?? "http://127.0.0.1:3000";
const HEALTH_URL = args.healthUrl ?? process.env.NEXTJS_HEALTH_URL ?? "http://localhost:3001";
const ORG_ID = args.orgId ?? process.env.MESSAGE_LAYER_ORG_ID ?? "";
const CURSOR_API_KEY = process.env.CURSOR_API_KEY ?? "";
const DEFAULT_REPOSITORY = process.env.CURSOR_DEFAULT_REPOSITORY ?? "";
const DEFAULT_REF = process.env.CURSOR_DEFAULT_REF ?? "main";
const ONCE = args.once;

const COMMAND_NAME = "cursor";

type CursorInvocation = {
  runId: string;
  prompt: string;
  repository: string | null;
  ref: string | null;
  /** Stream the invocation happened on (channel or thread). */
  streamId: string;
  streamType: "channel" | "thread";
  /** Message that carried the `/cursor` part or the `@cursor` mention. */
  sourceMessageId: string;
  /** Channel the stream resolves to (for channel→thread creation). */
  channelId: string;
  /** Human-readable label describing *how* this invocation arrived. */
  trigger: "command" | "mention";
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

function parseFrame(raw: WebSocket.RawData): {
  type: string;
  lastSeq?: number;
  streamId?: string;
  event?: {
    type?: string;
    streamId?: string;
    streamSeq?: number;
    payload?: Record<string, unknown>;
  };
  error?: string;
} | null {
  try {
    return JSON.parse(raw.toString()) as {
      type: string;
      lastSeq?: number;
      streamId?: string;
      event?: {
        type?: string;
        streamId?: string;
        streamSeq?: number;
        payload?: Record<string, unknown>;
      };
      error?: string;
    };
  } catch {
    return null;
  }
}

function statusEmoji(status: AgentStatus): string {
  switch (status) {
    case "FINISHED":
      return "✅";
    case "FAILED":
      return "❌";
    case "STOPPED":
      return "⏹";
    default:
      return "⏳";
  }
}

/**
 * `/cursor` can be invoked as either `cursor` or `<owner>:cursor` depending
 * on whether the caller disambiguated the owner in long form. We accept
 * either shape — the server has already resolved ownership (via
 * `ownerActorId` on the event) so we just need to spot our command name.
 */
function isCursorCommand(command: string): boolean {
  if (!command) return false;
  const lower = command.toLowerCase();
  if (lower === COMMAND_NAME) return true;
  return lower.endsWith(`:${COMMAND_NAME}`);
}

function extractPromptFromCommandPart(message: MlMessage, partIndex: number): {
  prompt: string;
  repository: string | null;
  ref: string | null;
} {
  const part = message.parts[partIndex];
  if (!part || part.type !== "command") {
    return { prompt: "", repository: null, ref: null };
  }
  const args = (part.payload.args ?? {}) as Record<string, unknown>;
  const prompt =
    (typeof args.text === "string" && args.text.trim()) ||
    (typeof args.prompt === "string" && args.prompt.trim()) ||
    "";
  const repository =
    typeof args.repository === "string" && args.repository.trim().length > 0
      ? args.repository.trim()
      : null;
  const ref =
    typeof args.ref === "string" && args.ref.trim().length > 0
      ? args.ref.trim()
      : null;
  return { prompt: String(prompt), repository, ref };
}

/**
 * For `@cursor do a thing`, the prompt is the surrounding text in the same
 * message. We collect every `text` part into one blob — the agent can
 * sort out which bit was addressed to it. We intentionally don't strip the
 * literal `@cursor` label because Cursor's own prompt handling can tolerate
 * noise and stripping would require re-parsing the mention start/end
 * offsets against the text, which is brittle.
 */
function extractPromptFromMention(message: MlMessage): string {
  const texts: string[] = [];
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    const text = part.payload?.text;
    if (typeof text === "string" && text.trim().length > 0) {
      texts.push(text);
    }
  }
  return texts.join("\n").trim();
}

async function loadMessageById(
  client: MessageLayerClient,
  streamId: string,
  messageId: string,
  streamSeq: number,
): Promise<MlMessage | null> {
  const afterSeq = Math.max(0, streamSeq - 1);
  const messages = await client.listMessages(streamId, afterSeq);
  return messages.find((m) => m.id === messageId) ?? null;
}

async function handleInvocation(
  cursorApi: CursorApiClient,
  client: MessageLayerClient,
  selfActorId: string,
  invocation: CursorInvocation,
): Promise<void> {
  const repository = invocation.repository ?? DEFAULT_REPOSITORY;
  const ref = invocation.ref ?? DEFAULT_REF;

  // Anchor a new public thread off the source message if we're still at
  // channel scope. Threads in threads are not a thing in message-layer, so
  // when the invocation already happens in a thread we stay put.
  let targetStreamId = invocation.streamId;
  let targetStreamType: "channel" | "thread" = invocation.streamType;
  if (invocation.streamType === "channel") {
    const created = await client.createThread(
      invocation.channelId,
      invocation.sourceMessageId,
      "public",
    );
    if (!created.ok) {
      console.warn(
        `[cursor] could not create thread for run ${invocation.runId}: ${created.message}`,
      );
      return;
    }
    targetStreamId = created.threadId;
    targetStreamType = "thread";
  }

  if (!repository) {
    await client.appendParts({
      streamId: targetStreamId,
      streamType: targetStreamType,
      parts: [
        {
          type: "text",
          payload: {
            text:
              "Cannot launch Cursor agent: no repository provided. Set `CURSOR_DEFAULT_REPOSITORY`, " +
              "or pass `repository=<url>` as a `/cursor` argument.",
            kind: "cursor_error",
          },
        },
      ],
    });
    return;
  }

  const triggerLabel = invocation.trigger === "command" ? "`/cursor`" : "`@cursor` mention";
  const ack = await client.appendParts({
    streamId: targetStreamId,
    streamType: targetStreamType,
    parts: [
      {
        type: "text",
        payload: {
          text: `Launching Cursor cloud agent for ${triggerLabel} (run \`${invocation.runId.slice(0, 8)}\`)…`,
          kind: "cursor_status",
        },
      },
      {
        type: "tool_call",
        payload: {
          toolName: "cursor.run",
          args: {
            runId: invocation.runId,
            prompt: invocation.prompt,
            repository,
            ref,
            trigger: invocation.trigger,
          },
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
      streamId: targetStreamId,
      streamType: targetStreamType,
      parts: [
        {
          type: "text",
          payload: { text: `Failed to launch Cursor agent: ${msg}`, kind: "cursor_error" },
        },
        {
          type: "tool_result",
          payload: {
            toolName: "cursor.run",
            content: JSON.stringify(
              { runId: invocation.runId, status: "failed", error: msg },
              null,
              2,
            ),
          },
        },
      ],
    });
    return;
  }

  const startedLines = [`Cursor agent \`${agentId}\` is running.`];
  if (agentUrl) startedLines.push(`[View agent](${agentUrl})`);
  await client.appendParts({
    streamId: targetStreamId,
    streamType: targetStreamType,
    parts: [
      {
        type: "text",
        payload: { text: startedLines.join("\n"), kind: "cursor_status" },
      },
    ],
  });

  let finalAgent: Awaited<ReturnType<CursorApiClient["waitForTerminal"]>>;
  try {
    finalAgent = await cursorApi.waitForTerminal(agentId, { pollMs: 5000 });
    console.log(
      `[cursor] agent ${agentId} finished with status ${finalAgent.status}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cursor] agent ${agentId} error during polling: ${msg}`);
    await client.appendParts({
      streamId: targetStreamId,
      streamType: targetStreamType,
      parts: [
        {
          type: "text",
          payload: { text: `Cursor agent error: ${msg}`, kind: "cursor_error" },
        },
        {
          type: "tool_result",
          payload: {
            toolName: "cursor.run",
            content: JSON.stringify(
              { runId: invocation.runId, agentId, status: "error", error: msg },
              null,
              2,
            ),
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
  if (finalAgent.summary) resultLines.push("", finalAgent.summary);
  if (finalAgent.target?.prUrl) {
    resultLines.push("", `[View pull request](${finalAgent.target.prUrl})`);
  } else if (agentUrl) {
    resultLines.push("", `[View agent](${agentUrl})`);
  }

  const posted = await client.appendParts({
    streamId: targetStreamId,
    streamType: targetStreamType,
    parts: [
      { type: "text", payload: { text: resultLines.join("\n") } },
      {
        type: "tool_result",
        payload: {
          toolName: "cursor.run",
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
    ],
  });
  if (!posted.ok) {
    console.warn(
      `[cursor] failed to post completion for ${invocation.runId}: ${posted.message}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWebsocketUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Unexpected server response: 404") ||
    message.includes("websocket error") ||
    message.includes("ECONNREFUSED")
  );
}

async function handleCursorEvent(input: {
  cursorApi: CursorApiClient;
  client: MessageLayerClient;
  principal: Principal;
  eventType: string;
  payload: Record<string, unknown>;
  streamId: string;
  streamSeq: number;
  remember: (messageId: string) => boolean;
}): Promise<boolean> {
  const { cursorApi, client, principal, eventType, payload, streamId, streamSeq, remember } =
    input;
  if (eventType === "command.invoked") {
    const command =
      typeof payload.command === "string" ? payload.command : "";
    if (!isCursorCommand(command)) return false;
    const ownerActorId =
      typeof payload.ownerActorId === "string" ? payload.ownerActorId : null;
    if (ownerActorId !== principal.actorId) return false;

    const messageId =
      typeof payload.messageId === "string" ? payload.messageId : "";
    if (!messageId) return false;
    if (!remember(messageId)) return false;

    const partIndex =
      typeof payload.partIndex === "number" ? payload.partIndex : -1;
    const streamType =
      payload.streamType === "thread" ? "thread" : "channel";
    const sourceStreamId =
      typeof payload.streamId === "string" ? payload.streamId : streamId;

    const message = await loadMessageById(
      client,
      sourceStreamId,
      messageId,
      streamSeq,
    );
    if (!message) return false;
    const { prompt, repository, ref } =
      partIndex >= 0
        ? extractPromptFromCommandPart(message, partIndex)
        : { prompt: "", repository: null, ref: null };
    if (!prompt) {
      console.warn(
        `[cursor] /${COMMAND_NAME} invoked without a prompt (messageId=${messageId.slice(0, 8)})`,
      );
      return false;
    }

    await handleInvocation(cursorApi, client, principal.actorId, {
      runId: randomUUID().replace(/-/g, ""),
      prompt,
      repository,
      ref,
      streamId: sourceStreamId,
      streamType,
      channelId: streamType === "channel" ? sourceStreamId : streamId,
      sourceMessageId: messageId,
      trigger: "command",
    });
    return true;
  }

  if (eventType === "mention.recorded") {
    const mentionedActorId =
      typeof payload.mentionedActorId === "string"
        ? payload.mentionedActorId
        : null;
    if (mentionedActorId !== principal.actorId) return false;
    const messageId =
      typeof payload.messageId === "string" ? payload.messageId : "";
    if (!messageId) return false;
    if (!remember(messageId)) return false;

    const actorId =
      typeof payload.actorId === "string" ? payload.actorId : "";
    if (actorId === principal.actorId) return false;
    const streamType =
      payload.streamType === "thread" ? "thread" : "channel";
    const sourceStreamId =
      typeof payload.streamId === "string" ? payload.streamId : streamId;

    const message = await loadMessageById(
      client,
      sourceStreamId,
      messageId,
      streamSeq,
    );
    if (!message) return false;
    const prompt = extractPromptFromMention(message);
    if (!prompt) {
      console.warn(
        `[cursor] @cursor mention had no prompt text (messageId=${messageId.slice(0, 8)})`,
      );
      return false;
    }

    await handleInvocation(cursorApi, client, principal.actorId, {
      runId: randomUUID().replace(/-/g, ""),
      prompt,
      repository: null,
      ref: null,
      streamId: sourceStreamId,
      streamType,
      channelId: streamType === "channel" ? sourceStreamId : streamId,
      sourceMessageId: messageId,
      trigger: "mention",
    });
    return true;
  }
  return false;
}

async function pollLoop(input: {
  cursorApi: CursorApiClient;
  client: MessageLayerClient;
  principal: Principal;
  processed: Set<string>;
  once: boolean;
}): Promise<void> {
  const streamLastSeq = new Map<string, number>();
  let handled = 0;
  const remember = (messageId: string): boolean => {
    if (input.processed.has(messageId)) return false;
    input.processed.add(messageId);
    return true;
  };

  for (;;) {
    const channels = await input.client.listChannels();
    const streams: Array<{ streamId: string; streamType: "channel" | "thread" }> = [];
    for (const channel of channels) {
      streams.push({ streamId: channel.id, streamType: "channel" });
      try {
        const threads = await input.client.listThreads(channel.id);
        for (const thread of threads) {
          streams.push({ streamId: thread.id, streamType: "thread" });
        }
      } catch (error) {
        console.warn(
          `[cursor] polling could not list threads for channel ${channel.id.slice(0, 8)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    for (const stream of streams) {
      const fromSeq = streamLastSeq.get(stream.streamId) ?? 0;
      const events = await input.client.listStreamEvents(stream.streamId, fromSeq);
      let maxSeq = fromSeq;
      for (const event of events) {
        if (typeof event.streamSeq === "number") {
          maxSeq = Math.max(maxSeq, event.streamSeq);
        }
        if (typeof event.streamSeq !== "number") continue;
        try {
          const didHandle = await handleCursorEvent({
            cursorApi: input.cursorApi,
            client: input.client,
            principal: input.principal,
            eventType: event.type,
            payload: event.payload,
            streamId: stream.streamId,
            streamSeq: event.streamSeq,
            remember,
          });
          if (didHandle) handled += 1;
        } catch (error) {
          console.error(
            `[cursor] error handling ${event.type}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      streamLastSeq.set(stream.streamId, maxSeq);
    }

    if (input.once && handled >= 1) return;
    await sleep(2200);
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

  try {
    const me = await cursorApi.getMe();
    console.log(`[cursor] authenticated as ${me.userEmail} (key: ${me.apiKeyName})`);
  } catch (err) {
    throw new Error(
      `Cursor API key check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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

  // Register the `/cursor` slash command. Lands as pending until an admin
  // approves it via the Next.js admin UI (same lifecycle as poet's `/poem`).
  const registration = await client.registerCommand({
    name: COMMAND_NAME,
    description: "Launch a Cursor Cloud Agent on a git repository.",
    argsSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Prompt for the Cursor cloud agent (what it should do).",
        },
        repository: {
          type: "string",
          description: "GitHub repository URL. Defaults to CURSOR_DEFAULT_REPOSITORY.",
        },
        ref: { type: "string", description: "Git ref. Defaults to main." },
      },
      required: ["text"],
    },
  });
  if (registration.ok) {
    console.log(
      `[cursor] registered /${COMMAND_NAME} (commandId=${registration.commandId}, request=${registration.requestId})`,
    );
  } else {
    console.log(
      `[cursor] could not register /${COMMAND_NAME} yet: ${registration.message}`,
    );
  }

  const channels = await client.listChannels();
  if (channels.length === 0) {
    throw new Error("No channels visible to cursor-agent.");
  }
  const threadIds = new Set<string>();
  for (const channel of channels) {
    try {
      const threads = await client.listThreads(channel.id);
      for (const thread of threads) threadIds.add(thread.id);
    } catch (error) {
      console.warn(
        `[cursor] could not list threads for channel ${channel.id.slice(0, 8)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const ws = new WebSocket(toWsUrl(BASE_URL), {
    headers: { "x-principal": JSON.stringify(principal) },
  });
  const streamLastSeq = new Map<string, number>();
  // Dedupe per source message id. If a single message carries both `/cursor`
  // and `@cursor`, we still launch exactly one run.
  const processed = new Set<string>();
  let handled = 0;
  let ready = false;

  function remember(messageId: string): boolean {
    if (processed.has(messageId)) return false;
    processed.add(messageId);
    return true;
  }

  try {
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
      for (const threadId of threadIds) {
        ws.send(
          JSON.stringify({
            type: "subscribe",
            streamId: threadId,
            streamType: "thread",
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
        streamLastSeq.set(
          frame.streamId,
          Math.max(streamLastSeq.get(frame.streamId) ?? 0, frame.lastSeq ?? 0),
        );
        return;
      }
      if (frame.type === "error") {
        reject(new Error(frame.error ?? "websocket error"));
        return;
      }
      if (frame.type !== "event") return;

      const eventType = frame.event?.type;
      const payload = (frame.event?.payload ?? {}) as Record<string, unknown>;
      const streamId = frame.event?.streamId ?? null;
      const streamSeq =
        typeof frame.event?.streamSeq === "number" ? frame.event.streamSeq : null;
      if (!streamId || streamSeq === null) return;

      if (eventType === "thread.created") {
        const threadId =
          typeof payload.threadId === "string" ? payload.threadId : null;
        if (threadId && !threadIds.has(threadId)) {
          threadIds.add(threadId);
          ws.send(
            JSON.stringify({
              type: "subscribe",
              streamId: threadId,
              streamType: "thread",
              fromSeq: 0,
            }),
          );
        }
        return;
      }

      try {
        const didHandle = await handleCursorEvent({
          cursorApi,
          client,
          principal,
          eventType: eventType ?? "",
          payload,
          streamId,
          streamSeq,
          remember,
        });
        if (didHandle) handled += 1;
      } catch (error) {
        console.error(
          `[cursor] error handling ${eventType ?? "event"}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (ONCE && handled >= 1) {
        ws.close(1000, "once complete");
        resolve();
      }
    });

    ws.on("error", (error) => reject(error));
    ws.on("close", () => {
      if (!ONCE) resolve();
    });
    });
  } catch (error) {
    if (!isWebsocketUnavailable(error)) throw error;
    console.warn(
      `[cursor] websocket unavailable (${error instanceof Error ? error.message : String(error)}); falling back to polling mode`,
    );
    await pollLoop({
      cursorApi,
      client,
      principal,
      processed,
      once: ONCE,
    });
  }
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
  console.log(
    `cursor agent — listens for /${COMMAND_NAME} and @cursor mentions, runs Cursor cloud agents\n\n` +
      `Usage: pnpm start --org-id <orgId> [--once]\n` +
      `Env:   CURSOR_API_KEY, CURSOR_DEFAULT_REPOSITORY, CURSOR_DEFAULT_REF`,
  );
  process.exit(0);
}

void run().catch((error) => {
  console.error(`[cursor] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
