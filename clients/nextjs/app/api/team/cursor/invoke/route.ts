import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { appendMessage, createThread, listMessages } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

type InvokeBody = {
  channelId?: string;
  parentMessageId?: string;
  instruction?: string;
  prompt?: string;
  threadId?: string;
};

type InvokeResponse = {
  ok: true;
  threadId: string;
  runId: string;
};

function extractTextPart(message: {
  parts: Array<{ type: string; payload: Record<string, unknown> }>;
}): string {
  const part = message.parts.find((item) => item.type === "text");
  const text = part?.payload?.text;
  return typeof text === "string" ? text : "";
}

export async function POST(request: Request) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const body = (await request.json()) as InvokeBody;
    const channelId = (body.channelId ?? "").trim();
    const parentMessageId = (body.parentMessageId ?? "").trim();
    const explicitThreadId = (body.threadId ?? "").trim();
    const instruction = (body.instruction ?? body.prompt ?? "").trim();
    if (!channelId) {
      return NextResponse.json({ error: "channelId is required" }, { status: 400 });
    }
    if (!parentMessageId && !explicitThreadId) {
      return NextResponse.json(
        { error: "parentMessageId or threadId is required" },
        { status: 400 },
      );
    }

    let threadId = explicitThreadId;
    if (!threadId) {
      // Cursor runs should be visible to all workspace actors in the channel.
      threadId = await createThread(principal, channelId, parentMessageId, "public");
    }

    let parentText = "";
    if (parentMessageId) {
      const channelMessages = await listMessages(principal, channelId, 0);
      const parentMessage = channelMessages.find(
        (message) => message.id === parentMessageId,
      );
      if (parentMessage) {
        parentText = extractTextPart(parentMessage).slice(0, 1200);
      }
    }

    const invocationPrompt =
      instruction.length > 0
        ? instruction
        : `Please help with this message context:\n${parentText || "(no text content found)"}`;
    const runId = randomUUID().replace(/-/g, "");
    const idempotencyKey = `cursor-invoke-${randomUUID()}`;
    const marker = {
      type: "tool_call" as const,
      payload: {
        toolName: "cursor.invoke",
        args: {
          runId,
          channelId,
          threadId,
          streamType: "thread",
          requesterActorId: principal.actorId,
          parentMessageId: parentMessageId || null,
          prompt: invocationPrompt,
        },
      },
    };
    const introText = {
      type: "text" as const,
      payload: {
        text: `@cursor ${invocationPrompt}`,
      },
    };
    await appendMessage(principal, {
      streamId: threadId,
      streamType: "thread",
      idempotencyKey,
      parts: [introText, marker],
    });

    return NextResponse.json({
      ok: true,
      threadId,
      runId,
    } satisfies InvokeResponse);
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 },
    );
  }
}
