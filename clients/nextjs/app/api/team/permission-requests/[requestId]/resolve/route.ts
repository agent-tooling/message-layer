import { NextResponse } from "next/server";
import { resolvePermissionRequest, type ResolveOptions } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

type Params = { params: Promise<{ requestId: string }> };

type Body = {
  approve?: boolean;
  notes?: string;
  expiresAt?: string | null;
  maxUses?: number | null;
};

export async function POST(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { requestId } = await params;
    const body = (await request.json()) as Body;
    if (typeof body.approve !== "boolean") {
      return NextResponse.json({ error: "approve must be a boolean" }, { status: 400 });
    }
    if (body.maxUses != null && (!Number.isInteger(body.maxUses) || body.maxUses < 1)) {
      return NextResponse.json({ error: "maxUses must be a positive integer or null" }, { status: 400 });
    }
    if (body.expiresAt != null) {
      if (typeof body.expiresAt !== "string" || Number.isNaN(Date.parse(body.expiresAt))) {
        return NextResponse.json({ error: "expiresAt must be ISO-8601 or null" }, { status: 400 });
      }
    }
    const options: ResolveOptions = {
      notes: typeof body.notes === "string" ? body.notes : undefined,
      expiresAt: body.expiresAt ?? null,
      maxUses: body.maxUses ?? null,
    };
    await resolvePermissionRequest(principal, requestId, body.approve, options);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
