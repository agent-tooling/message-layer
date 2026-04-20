import { NextResponse } from "next/server";
import { addChannelMember, listChannelMembers } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

type Params = { params: Promise<{ channelId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { channelId } = await params;
    const members = await listChannelMembers(principal, channelId);
    return NextResponse.json({ members });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { channelId } = await params;
    const body = (await request.json()) as { actorId?: string; role?: string };
    const actorId = (body.actorId ?? "").trim();
    if (!actorId) {
      return NextResponse.json({ error: "actorId is required" }, { status: 400 });
    }
    await addChannelMember(principal, channelId, actorId, body.role ?? "member");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
