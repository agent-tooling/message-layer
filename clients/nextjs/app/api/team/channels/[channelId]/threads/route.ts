import { NextResponse } from "next/server";
import { createThread, listThreads } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

type Params = { params: Promise<{ channelId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { channelId } = await params;
    const threads = await listThreads(principal, channelId);
    return NextResponse.json({ threads });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { channelId } = await params;
    const body = (await request.json()) as { parentMessageId?: string };
    const parentMessageId = (body.parentMessageId ?? "").trim();
    if (!parentMessageId) {
      return NextResponse.json({ error: "parentMessageId is required" }, { status: 400 });
    }
    const threadId = await createThread(principal, channelId, parentMessageId);
    return NextResponse.json({ threadId });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
