import { NextResponse } from "next/server";
import { getUserIdByActorId, getUserRole } from "@/lib/app-db";
import { checkActorCapability, listMembers } from "@/lib/message-layer";
import { requirePrincipal } from "@/lib/server-auth";

export async function GET(request: Request) {
  try {
    const { principal } = await requirePrincipal(request.headers);
    const members = await listMembers(principal);
    const capabilities = ["message:append", "thread:create", "channel:create", "grant:create", "audit:read"];
    const withRoles = await Promise.all(
      members.map(async (member) => {
        const userId = getUserIdByActorId(member.actorId);
        const appRole = userId ? getUserRole(userId) : null;
        const effectiveCapabilities: string[] = [];
        for (const capability of capabilities) {
          if (await checkActorCapability(principal, member.actorId, capability)) {
            effectiveCapabilities.push(capability);
          }
        }
        return {
          ...member,
          appRole,
          effectiveCapabilities,
        };
      }),
    );
    return NextResponse.json({ members: withRoles });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 401 });
  }
}
