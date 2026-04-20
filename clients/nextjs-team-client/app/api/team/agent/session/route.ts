import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function GET(request: Request) {
  const agentSession = await auth.api.getAgentSession({
    headers: request.headers,
  });
  if (!agentSession) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    agent: agentSession.agent,
    user: agentSession.user,
  });
}
