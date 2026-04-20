import { basename } from "node:path";
import { NextResponse } from "next/server";
import { attachmentStore } from "@/lib/attachment-store";
import { requirePrincipal } from "@/lib/server-auth";

type Params = { params: Promise<{ attachmentId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const { attachmentId } = await params;
    const attachment = await attachmentStore.get(attachmentId);
    if (!attachment) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (attachment.row.org_id !== principal.orgId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return new NextResponse(new Uint8Array(attachment.bytes), {
      status: 200,
      headers: {
        "content-type": attachment.row.mime_type,
        "content-disposition": `inline; filename="${basename(attachment.row.filename)}"`,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }
}
