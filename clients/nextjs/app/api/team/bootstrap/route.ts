import { NextResponse } from "next/server";
import { getDefaultChannelId, listChannels } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

export async function POST(request: Request) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const channels = await listChannels(principal);
    const defaultChannelId = channels[0]?.id ?? (await getDefaultChannelId());
    return NextResponse.json({ ok: true, orgId: principal.orgId, actorId: principal.actorId, defaultChannelId });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }
}
