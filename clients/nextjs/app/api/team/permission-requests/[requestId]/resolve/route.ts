import { NextResponse } from "next/server";
import { resolvePermissionRequest } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

type Params = { params: Promise<{ requestId: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { requestId } = await params;
    const body = (await request.json()) as { approve?: boolean; notes?: string };
    if (typeof body.approve !== "boolean") {
      return NextResponse.json({ error: "approve must be a boolean" }, { status: 400 });
    }
    await resolvePermissionRequest(principal, requestId, body.approve, body.notes ?? "");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
