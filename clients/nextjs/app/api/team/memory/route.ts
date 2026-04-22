import { NextResponse } from "next/server";
import { listMemory } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const streamId = url.searchParams.get("streamId");
  if (!streamId) {
    return NextResponse.json({ error: "streamId is required" }, { status: 400 });
  }
  try {
    const { principal } = await requirePrincipal(request.headers);
    const units = await listMemory(principal, streamId);
    return NextResponse.json({ units, available: true });
  } catch (error) {
    const message = (error as Error).message;
    // The plugin is optional. When the server is configured without the
    // `memory` plugin enabled the route returns 404; fall back to "not
    // available" so the UI can hide the panel rather than show an error.
    if (message.includes("404") || message.includes("Not Found")) {
      return NextResponse.json({ units: [], available: false });
    }
    if (message.includes("403")) {
      return NextResponse.json({ units: [], available: true, denied: true });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
