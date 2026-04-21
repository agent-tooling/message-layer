import { NextResponse } from "next/server";
import { listActorEffectiveGrants } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

type Params = { params: Promise<{ actorId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { actorId } = await params;
    const grants = await listActorEffectiveGrants(principal, actorId);
    return NextResponse.json({ grants });
  } catch (error) {
    const message = (error as Error).message;
    const status = /401|unauthorized|missing/i.test(message) ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
