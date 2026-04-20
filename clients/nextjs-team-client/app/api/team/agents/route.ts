import { NextResponse } from "next/server";
import { listActors } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

export async function GET(request: Request) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const actors = await listActors(principal);
    const agents = actors.filter((actor) => actor.actorType === "agent");
    return NextResponse.json({ agents });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }
}
