import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/app-db";

function hasWorkspace(): boolean {
  return Boolean(getSetting("first_user_id") ?? getSetting("default_org_id"));
}

export async function GET() {
  return NextResponse.json({
    hasWorkspace: hasWorkspace(),
    workspaceName: getSetting("workspace_name") ?? null,
    orgId: getSetting("default_org_id") ?? null,
  });
}

export async function POST(request: Request) {
  try {
    if (hasWorkspace()) {
      return NextResponse.json({ error: "workspace is already initialized" }, { status: 409 });
    }
    const body = (await request.json()) as { workspaceName?: string };
    const workspaceName = (body.workspaceName ?? "").trim();
    if (!workspaceName) {
      return NextResponse.json({ error: "workspaceName is required" }, { status: 400 });
    }
    setSetting("workspace_name", workspaceName);
    return NextResponse.json({ ok: true, workspaceName });
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }
}
