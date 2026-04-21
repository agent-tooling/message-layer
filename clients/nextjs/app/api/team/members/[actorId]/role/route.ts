import { NextResponse } from "next/server";
import { canManageRoles, parseHumanRoleInput, setActorRole } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

type Params = { params: Promise<{ actorId: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const allowed = await canManageRoles(principal);
    if (!allowed) {
      return NextResponse.json({ error: "missing role-management capability" }, { status: 403 });
    }
    const { actorId } = await params;
    const body = (await request.json()) as { role?: string };
    const role = parseHumanRoleInput(body.role ?? "");
    if (!role || role === "owner") {
      return NextResponse.json({ error: "role must be admin or member" }, { status: 400 });
    }
    await setActorRole(actorId, role);
    return NextResponse.json({ ok: true, actorId, role });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
