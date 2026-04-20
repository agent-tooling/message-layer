import { NextResponse } from "next/server";
import { appendMessage, listMessages } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

type Params = { params: Promise<{ channelId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { channelId } = await params;
    const url = new URL(request.url);
    const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
    const messages = await listMessages(principal, channelId, afterSeq);
    return NextResponse.json({ messages });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { channelId } = await params;
    const body = (await request.json()) as { text?: string; attachments?: Array<{ id: string; name: string; mimeType: string; sizeBytes: number; url: string }> };
    const text = (body.text ?? "").trim();
    const parts: Array<{ type: "text" | "artifact"; payload: Record<string, unknown> }> = [];
    if (text) {
      parts.push({ type: "text", payload: { text } });
    }
    for (const attachment of body.attachments ?? []) {
      parts.push({
        type: "artifact",
        payload: {
          attachmentId: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          url: attachment.url,
        },
      });
    }
    if (parts.length === 0) {
      return NextResponse.json({ error: "text or attachment required" }, { status: 400 });
    }
    await appendMessage(principal, {
      streamId: channelId,
      streamType: "channel",
      parts,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
