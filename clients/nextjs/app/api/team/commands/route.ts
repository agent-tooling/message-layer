import { NextResponse } from "next/server";
import { listCommands } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

export async function GET(request: Request) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const url = new URL(request.url);
    const channelId = (url.searchParams.get("channelId") ?? "").trim() || null;
    const commands = await listCommands(principal, channelId);
    return NextResponse.json({ commands });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
