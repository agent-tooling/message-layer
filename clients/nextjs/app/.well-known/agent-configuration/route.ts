import { getAgentConfiguration } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const configuration = await getAgentConfiguration(request.headers);
  return NextResponse.json(configuration);
}
