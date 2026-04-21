import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createInvite, listInvites } from "@/lib/app-db";
import { env } from "@/lib/env";
import { parseHumanRoleInput } from "@/lib/message-layer";
import { requireSession } from "@/lib/server-auth";

export async function GET(request: Request) {
  try {
    await requireSession(request.headers);
    return NextResponse.json({ invites: listInvites() });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession(request.headers);
    const body = (await request.json()) as { email?: string; role?: string };
    const email = (body.email ?? "").trim().toLowerCase();
    const requestedRole = parseHumanRoleInput(body.role ?? "member");
    if (!email) {
      return NextResponse.json({ error: "email is required" }, { status: 400 });
    }
    if (!requestedRole || requestedRole === "owner") {
      return NextResponse.json({ error: "role must be admin or member" }, { status: 400 });
    }
    const token = randomUUID().replace(/-/g, "");
    createInvite({
      token,
      email,
      role: requestedRole,
      inviterUserId: session.user.id,
      createdAt: new Date().toISOString(),
    });
    const inviteUrl = `${env.NEXT_PUBLIC_APP_URL}/invite/accept?token=${token}`;
    return NextResponse.json({ token, inviteUrl });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }
}
