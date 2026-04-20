import { NextResponse } from "next/server";
import { redactMessage } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

type Params = { params: Promise<{ messageId: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { messageId } = await params;
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    await redactMessage(principal, messageId, body.reason ?? "");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
