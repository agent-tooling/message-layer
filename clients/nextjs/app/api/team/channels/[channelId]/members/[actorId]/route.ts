import { NextResponse } from "next/server";
import { removeChannelMember } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

type Params = { params: Promise<{ channelId: string; actorId: string }> };

export async function DELETE(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { channelId, actorId } = await params;
    await removeChannelMember(principal, channelId, actorId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
