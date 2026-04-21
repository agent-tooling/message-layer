import { NextResponse } from "next/server";
import { revokeGrant } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

type Params = { params: Promise<{ grantId: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { grantId } = await params;
    await revokeGrant(principal, grantId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = (error as Error).message;
    const status = /401|unauthorized|missing/i.test(message) ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
