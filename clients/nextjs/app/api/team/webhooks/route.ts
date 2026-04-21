import { NextResponse } from "next/server";
import { listWebhookSubscriptions } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

export async function GET(request: Request) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const subscriptions = await listWebhookSubscriptions(principal);
    return NextResponse.json({ subscriptions, available: true });
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("404") || message.includes("Not Found")) {
      return NextResponse.json({ subscriptions: [], available: false });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
