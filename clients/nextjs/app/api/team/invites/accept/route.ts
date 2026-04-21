import { NextResponse } from "next/server";
import { consumeInvite, setUserRole } from "@/lib/app-db";
import { parseHumanRoleInput, setUserRoleForPrincipal } from "@/lib/message-layer";
import { requireSession } from "@/lib/server-auth";

export async function POST(request: Request) {
  try {
    const session = await requireSession(request.headers);
    const body = (await request.json()) as { token?: string };
    const token = (body.token ?? "").trim();
    if (!token) {
      return NextResponse.json({ error: "token is required" }, { status: 400 });
    }
    const invite = consumeInvite(token, session.user.id);
    if (!invite) {
      return NextResponse.json({ error: "invalid or already-used invite token" }, { status: 400 });
    }
    const role = parseHumanRoleInput(invite.role);
    if (!role || role === "owner") {
      return NextResponse.json({ error: "invite has unsupported role" }, { status: 400 });
    }
    setUserRole(session.user.id, role);
    await setUserRoleForPrincipal(
      {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name ?? null,
      },
      role,
    );
    return NextResponse.json({ ok: true, invite });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }
}
