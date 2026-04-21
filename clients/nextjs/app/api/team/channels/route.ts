import { NextResponse } from "next/server";
import { createChannel, createPermissionRequest, getDefaultChannelId, listChannels } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

export async function GET(request: Request) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const channels = await listChannels(principal);
    const fallback = channels.length > 0 ? channels : [{ id: await getDefaultChannelId(), name: "general", visibility: "public" }];
    return NextResponse.json({ channels: fallback });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }
}

export async function POST(request: Request) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const body = (await request.json()) as { name?: string };
    const name = (body.name ?? "").trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    try {
      const channelId = await createChannel(principal, name);
      return NextResponse.json({ channelId });
    } catch (error) {
      const message = (error as Error).message;
      if (!message.includes("missing channel:create")) {
        throw error;
      }
      const requestId = await createPermissionRequest(principal, {
        action: "channel:create",
        resourceType: "org",
        resourceId: principal.orgId,
        context: {
          kind: "channel.create",
          requestedName: name,
          requestedVisibility: "public",
          requestedByActorId: principal.actorId,
        },
      });
      return NextResponse.json(
        {
          error: "channel creation requires admin approval",
          permissionRequestId: requestId,
          capability: "channel:create",
        },
        { status: 403 },
      );
    }
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
