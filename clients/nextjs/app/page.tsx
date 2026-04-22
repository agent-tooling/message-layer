"use client";

import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { AuthPanel } from "@/components/auth-panel";
import { TeamWorkspace } from "@/components/team-workspace";

export default function HomePage() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
      </div>
    );
  }

  if (!session) {
    return <AuthPanel />;
  }

  return <TeamWorkspace />;
}
