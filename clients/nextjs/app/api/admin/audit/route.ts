import { NextResponse } from "next/server";
import { fetchAuditRows } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

/**
 * Read the per-org audit log, optionally filtered by `actorId`. Delegates
 * to core `GET /v1/audit/rows?actorId=...&limit=...`. The hash chain is
 * verified against the full (unfiltered) chain, so a sliced view here does
 * not weaken the integrity guarantee.
 */
export async function GET(request: Request) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const url = new URL(request.url);
    const actorId = url.searchParams.get("actorId") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Math.max(1, Math.min(1000, Number(limitRaw))) : undefined;
    const rows = await fetchAuditRows(principal, { actorId, limit });
    return NextResponse.json({ rows });
  } catch (error) {
    const message = (error as Error).message;
    const status = /401|unauthorized/i.test(message)
      ? 401
      : /403|permission_denied|missing audit:read scope/i.test(message)
        ? 403
        : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
