import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const configuration = await auth.api.getAgentConfiguration({
    headers: request.headers,
  });
  return NextResponse.json(configuration);
}
