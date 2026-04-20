import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { ensureUserPrincipal } from "@/lib/message-layer";

async function resolveHeaders(inputHeaders?: Headers): Promise<Headers> {
  if (inputHeaders) {
    return inputHeaders;
  }
  return await headers();
}

export async function requireSession(inputHeaders?: Headers) {
  const session = await auth.api.getSession({
    headers: await resolveHeaders(inputHeaders),
  });
  if (!session) {
    throw new Error("unauthorized");
  }
  return session;
}

export async function requirePrincipal(inputHeaders?: Headers) {
  const session = await requireSession(inputHeaders);
  const principal = await ensureUserPrincipal({
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? null,
  });
  return { session, principal };
}
