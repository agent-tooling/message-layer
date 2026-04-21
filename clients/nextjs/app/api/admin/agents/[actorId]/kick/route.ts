import { NextResponse } from "next/server";
import { revokeAllGrantsForActor } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

type Params = { params: Promise<{ actorId: string }> };

/**
 * "Kick" an agent: revoke every live grant it holds in one server call.
 * Delegates to the core `POST /v1/actors/:actorId/revoke-grants` endpoint
 * so the action lands in the per-org hash-chained audit log with one
 * `grant.revoked` event per affected grant.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { actorId } = await params;
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    const reason = typeof body?.reason === "string" ? body.reason : "";
    const result = await revokeAllGrantsForActor(principal, actorId, reason);
    return NextResponse.json(result);
  } catch (error) {
    const message = (error as Error).message;
    const status = /401|unauthorized|missing/i.test(message) ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
