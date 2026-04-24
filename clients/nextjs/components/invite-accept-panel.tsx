"use client";

import { useEffect, useState } from "react";
import { MailCheck, Loader2, MessageSquare, CheckCircle2, ArrowRight } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export function InviteAcceptPanel({ token }: { token: string }) {
  const { data: session } = authClient.useSession();
  const [status, setStatus] = useState<string>("ready");
  const [error, setError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/team/setup", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { workspaceName?: string | null }) => {
        if (d.workspaceName) setWorkspaceName(d.workspaceName);
      })
      .catch(() => {});
  }, []);

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
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10">
            <MailCheck className="h-6 w-6 text-emerald-400" />
          </div>
          {workspaceName && (
            <p className="mt-3 text-xs font-medium text-zinc-400">
              You have been invited to
            </p>
          )}
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-zinc-100">
            {workspaceName ?? "Accept invitation"}
          </h1>
        </div>

        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-6">
          {status === "accepted" ? (
            <div className="flex flex-col items-center py-4 text-center">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15">
                <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              </div>
              <p className="text-sm font-medium text-emerald-300">
                You have joined the workspace!
              </p>
              <p className="mt-1 text-xs text-zinc-400">
                Start collaborating with your team.
              </p>
              <Link href="/">
                <Button className="mt-4 gap-1.5">
                  Go to workspace
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
            </div>
          ) : (
            <>
              <div className="mb-4 rounded-lg border border-zinc-800/40 bg-zinc-950/50 px-3 py-2.5">
                <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                  <MessageSquare className="h-3.5 w-3.5" />
                  <span>Invite token</span>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-zinc-400">
                  {token}
                </p>
              </div>

              {session ? (
                <div>
                  <p className="mb-3 text-xs text-zinc-400">
                    Signed in as <span className="font-medium text-zinc-200">{session.user?.email}</span>
                  </p>
                  <Button className="w-full" onClick={accept} disabled={status === "working"}>
                    {status === "working" && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                    {status === "working" ? "Joining…" : "Accept and join"}
                  </Button>
                </div>
              ) : (
                <div className="text-center">
                  <p className="text-sm text-zinc-400">
                    Sign in first to accept this invitation.
                  </p>
                  <Link href="/">
                    <Button variant="outline" className="mt-3 gap-1.5">
                      Go to sign in
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </Link>
                </div>
              )}
            </>
          )}

          {error && (
            <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
