import { NextResponse } from "next/server";
import { consumeInvite } from "@/lib/app-db";
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
    return NextResponse.json({ ok: true, invite });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }
}
