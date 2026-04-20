import { NextResponse } from "next/server";
import { attachmentStore } from "@/lib/attachment-store";
import { requirePrincipal } from "@/lib/server-auth";

export async function POST(request: Request) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const formData = await request.formData();
    const streamId = String(formData.get("streamId") ?? "");
    const streamType = String(formData.get("streamType") ?? "channel") as "channel" | "thread";
    const file = formData.get("file");
    if (!streamId || !(file instanceof File)) {
      return NextResponse.json({ error: "streamId and file are required" }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const stored = await attachmentStore.put({
      orgId: principal.orgId,
      streamId,
      streamType,
      uploaderActorId: principal.actorId,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      bytes,
    });
    return NextResponse.json(stored);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }
}
