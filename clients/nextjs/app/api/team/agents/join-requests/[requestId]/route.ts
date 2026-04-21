import { NextResponse } from "next/server";
import { getAgentJoinRequestById, getAgentJoinRequestBySecret } from "@/lib/app-db";

type Params = { params: Promise<{ requestId: string }> };

export async function GET(request: Request, { params }: Params) {
  const { requestId } = await params;
  const url = new URL(request.url);
  const secret = (url.searchParams.get("secret") ?? "").trim();
  if (!secret) {
    return NextResponse.json({ error: "secret is required" }, { status: 400 });
  }
  const row = getAgentJoinRequestBySecret(requestId, secret);
  if (!row) {
    return NextResponse.json({ error: "join request not found" }, { status: 404 });
  }
  const byId = getAgentJoinRequestById(requestId);
  if (!byId) {
    return NextResponse.json({ error: "join request not found" }, { status: 404 });
  }
  return NextResponse.json({
    requestId: byId.id,
    status: byId.status,
    actorId: byId.actor_id,
    orgId: byId.org_id,
    note: byId.note,
  });
}
