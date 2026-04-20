import { NextResponse } from "next/server";
import { createChannel, getDefaultChannelId, listChannels } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

export async function GET(request: Request) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const channels = await listChannels(principal);
    const fallback = channels.length > 0 ? channels : [{ id: await getDefaultChannelId(), name: "general", visibility: "public" }];
    return NextResponse.json({ channels: fallback });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }
}

export async function POST(request: Request) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const body = (await request.json()) as { name?: string };
    const name = (body.name ?? "").trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const channelId = await createChannel(principal, name);
    return NextResponse.json({ channelId });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
