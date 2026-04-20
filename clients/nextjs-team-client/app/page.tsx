"use client";

import { authClient } from "@/lib/auth-client";
import { AuthPanel } from "@/components/auth-panel";
import { TeamWorkspace } from "@/components/team-workspace";

export default function HomePage() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <div className="p-8 text-sm text-zinc-300">Loading session...</div>;
  }

  if (!session) {
    return <AuthPanel />;
  }

  return <TeamWorkspace />;
}
