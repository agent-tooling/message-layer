"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

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
    <div className="mx-auto mt-16 w-full max-w-lg rounded-2xl border border-zinc-800/80 bg-zinc-950/80 p-8 shadow-2xl shadow-black/40">
      <h1 className="text-3xl font-semibold tracking-tight">Accept invitation</h1>
      <p className="mt-2 text-sm text-zinc-400">Token: {token.slice(0, 12)}...</p>
      {session ? (
        <button className="mt-6 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500" type="button" onClick={accept}>
          {status === "working" ? "Accepting..." : "Accept invite"}
        </button>
      ) : (
        <p className="mt-4 text-sm text-zinc-300">Sign in on the home page first, then come back to this link.</p>
      )}
      {status === "accepted" ? <p className="mt-4 text-sm text-emerald-400">Invite accepted. You can now use the workspace.</p> : null}
      {error ? <p className="mt-4 text-sm text-red-400">{error}</p> : null}
    </div>
  );
}
