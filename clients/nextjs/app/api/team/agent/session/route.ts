import { NextResponse } from "next/server";
import { getAgentSession } from "@/lib/auth";

export async function GET(request: Request) {
  const agentSession = (await getAgentSession(request.headers)) as {
    agent?: unknown;
    user?: unknown;
  } | null;
  if (!agentSession) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    agent: agentSession.agent,
    user: agentSession.user,
  });
}
