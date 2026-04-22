import { NextResponse } from "next/server";
import { searchEntities } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  if (!query) {
    return NextResponse.json({ hits: [], available: true });
  }
  const entityTypesRaw = url.searchParams.get("entityTypes");
  const entityTypes = entityTypesRaw
    ? entityTypesRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is "actor" | "channel" | "thread" | "message" | "memory" =>
          ["actor", "channel", "thread", "message", "memory"].includes(s),
        )
    : undefined;
  const streamId = url.searchParams.get("streamId") ?? undefined;
  const actorTypeRaw = url.searchParams.get("actorType");
  const actorType =
    actorTypeRaw === "human" || actorTypeRaw === "agent" || actorTypeRaw === "app"
      ? actorTypeRaw
      : undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  try {
    const { principal } = await requirePrincipal(request.headers);
    const result = await searchEntities(principal, query, {
      entityTypes,
      streamId,
      actorType,
      limit,
    });
    return NextResponse.json({ ...result, available: true });
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("404") || message.includes("Not Found")) {
      return NextResponse.json({ hits: [], available: false });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
