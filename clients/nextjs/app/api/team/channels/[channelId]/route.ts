import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/app-db";
import { deleteChannel, listChannels } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

type Params = { params: Promise<{ channelId: string }> };

export async function DELETE(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { channelId } = await params;
    await deleteChannel(principal, channelId);

    if (getSetting("default_channel_id") === channelId) {
      const remaining = await listChannels(principal);
      setSetting("default_channel_id", remaining[0]?.id ?? "");
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
