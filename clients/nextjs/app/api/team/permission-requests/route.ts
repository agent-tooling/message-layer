import { NextResponse } from "next/server";
import { listPermissionRequests } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

export async function GET(request: Request) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const url = new URL(request.url);
    const actorId = url.searchParams.get("actorId") ?? undefined;
    const requests = await listPermissionRequests(principal, actorId);
    return NextResponse.json({ requests });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }
}
