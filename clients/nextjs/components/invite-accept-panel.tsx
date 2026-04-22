"use client";

import { useState } from "react";
import { MailCheck, Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export function InviteAcceptPanel({ token }: { token: string }) {
  const { data: session } = authClient.useSession();
  const [status, setStatus] = useState<string>("ready");
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    try {
      setError(null);
      setStatus("working");
      const response = await fetch("/api/team/invites/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "failed to accept invite");
      }
      setStatus("accepted");
    } catch (err) {
      setError((err as Error).message);
      setStatus("ready");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-6">
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10">
          <MailCheck className="h-5 w-5 text-emerald-400" />
        </div>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-100">
          Accept invitation
        </h1>
        <p className="mt-1 text-xs text-zinc-500">
          Token: {token.slice(0, 12)}…
        </p>
        {session ? (
          <Button className="mt-5 w-full" onClick={accept} disabled={status === "working"}>
            {status === "working" && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {status === "working" ? "Accepting…" : "Accept invite"}
          </Button>
        ) : (
          <p className="mt-4 text-sm text-zinc-400">
            Sign in on the home page first, then come back to this link.
          </p>
        )}
        {status === "accepted" && (
          <div className="mt-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
            Invite accepted. You can now use the workspace.
          </div>
        )}
        {error && (
          <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
