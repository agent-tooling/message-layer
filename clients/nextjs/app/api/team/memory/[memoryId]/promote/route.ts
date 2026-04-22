import { NextResponse } from "next/server";
import { promoteMemory } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ memoryId: string }> },
) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { memoryId } = await params;
    let summary: string | undefined;
    try {
      const body = (await request.json()) as { summary?: unknown };
      if (typeof body.summary === "string") summary = body.summary;
    } catch {
      // body is optional
    }
    const unit = await promoteMemory(principal, memoryId, summary);
    return NextResponse.json({ unit });
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("403")) {
      return NextResponse.json(
        { error: "missing memory:promote" },
        { status: 403 },
      );
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
