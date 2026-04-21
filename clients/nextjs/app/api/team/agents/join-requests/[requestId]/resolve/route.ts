import { NextResponse } from "next/server";
import {
  getAgentJoinRequestById,
  resolveAgentJoinRequest,
} from "@/lib/app-db";
import { canManageRoles, createAgentActor } from "@/lib/message-layer";
import { requirePrincipal, requireSession } from "@/lib/server-auth";

type Params = { params: Promise<{ requestId: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const session = await requireSession(request.headers);
    if (!(await canManageRoles(principal))) {
      return NextResponse.json({ error: "missing role-management capability" }, { status: 403 });
    }
    const { requestId } = await params;
    const body = (await request.json()) as { approve?: boolean; note?: string };
    if (typeof body.approve !== "boolean") {
      return NextResponse.json({ error: "approve must be a boolean" }, { status: 400 });
    }
    const row = getAgentJoinRequestById(requestId);
    if (!row) {
      return NextResponse.json({ error: "join request not found" }, { status: 404 });
    }
    if (row.org_id !== principal.orgId) {
      return NextResponse.json({ error: "join request is not in this workspace" }, { status: 403 });
    }
    if (row.status !== "open") {
      return NextResponse.json({ error: `join request already ${row.status}` }, { status: 400 });
    }
    let actorId: string | null = null;
    if (body.approve) {
      actorId = await createAgentActor(principal.orgId, row.display_name);
    }
    resolveAgentJoinRequest({
      id: requestId,
      status: body.approve ? "approved" : "denied",
      actorId,
      note: (body.note ?? "").trim(),
      resolvedByUserId: session.user.id,
    });
    return NextResponse.json({
      ok: true,
      requestId,
      status: body.approve ? "approved" : "denied",
      actorId,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
