import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  createAgentJoinRequest,
  getSetting,
  listOpenAgentJoinRequests,
} from "@/lib/app-db";
import { canManageRoles } from "@/lib/message-layer";
import { requirePrincipal, requireSession } from "@/lib/server-auth";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { displayName?: string; orgId?: string };
    const displayName = (body.displayName ?? "").trim();
    if (!displayName) {
      return NextResponse.json({ error: "displayName is required" }, { status: 400 });
    }
    const defaultOrgId = getSetting("default_org_id");
    const orgId = (defaultOrgId ?? "").trim();
    if (!orgId) {
      return NextResponse.json({ error: "workspace is not initialized yet" }, { status: 409 });
    }
    const requestId = randomUUID().replace(/-/g, "");
    const requestSecret = randomUUID().replace(/-/g, "");
    createAgentJoinRequest({
      id: requestId,
      requestSecret,
      orgId,
      displayName,
      createdAt: new Date().toISOString(),
    });
    return NextResponse.json({
      requestId,
      requestSecret,
      orgId,
      status: "open",
      message: "join request submitted for admin approval",
    });
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
}

export async function GET(request: Request) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const session = await requireSession(request.headers);
    if (!(await canManageRoles(principal))) {
      return NextResponse.json({ error: "missing role-management capability" }, { status: 403 });
    }
    const requests = listOpenAgentJoinRequests(principal.orgId).map((row) => ({
      requestId: row.id,
      displayName: row.display_name,
      orgId: row.org_id,
      status: row.status,
      createdAt: row.created_at,
      requestedBy: "agent",
      viewerUserId: session.user.id,
    }));
    return NextResponse.json({ requests });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }
}
