"use client";

import { useEffect, useState } from "react";
import { MessageSquare, Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AuthPanel() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [setupChecked, setSetupChecked] = useState(false);
  const [hasWorkspace, setHasWorkspace] = useState(true);
  const [workspaceName, setWorkspaceName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/team/setup", { cache: "no-store" });
        const payload = (await response.json()) as {
          hasWorkspace?: boolean;
          workspaceName?: string | null;
        };
        setHasWorkspace(payload.hasWorkspace ?? true);
        if (!payload.hasWorkspace) {
          setIsSignUp(true);
          setWorkspaceName(payload.workspaceName ?? "");
        }
      } finally {
        setSetupChecked(true);
      }
    })();
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (isSignUp) {
        if (!hasWorkspace) {
          const setupResponse = await fetch("/api/team/setup", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceName }),
          });
          const setupPayload = (await setupResponse.json()) as { error?: string };
          if (!setupResponse.ok && setupResponse.status !== 409) {
            throw new Error(setupPayload.error ?? "failed to initialize workspace");
          }
        }
        const result = await authClient.signUp.email({
          email,
          password,
          name: name.trim() || email,
        });
        if (result.error) {
          throw new Error(result.error.message);
        }
      } else {
        const result = await authClient.signIn.email({
          email,
          password,
        });
        if (result.error) {
          throw new Error(result.error.message);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  if (!setupChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading setup…
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10">
            <MessageSquare className="h-6 w-6 text-emerald-400" />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight text-zinc-100">
            Message Layer
          </h1>
          <p className="mt-1 text-xs text-zinc-500">
            Team + agent coordination layer
          </p>
        </div>

        {/* Card */}
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-6">
          <h2 className="text-lg font-semibold tracking-tight text-zinc-100">
            {hasWorkspace ? (isSignUp ? "Create account" : "Sign in") : "Create workspace"}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-400">
            {hasWorkspace
              ? "Authenticate to join your workspace, channels, and agent controls."
              : "Set the workspace name and create the first admin account."}
          </p>

          <form className="mt-5 space-y-3" onSubmit={onSubmit}>
            {!hasWorkspace && (
              <div>
                <label className="mb-1 block text-[11px] font-medium text-zinc-400">
                  Workspace name
                </label>
                <Input
                  placeholder="My Team"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  required
                />
              </div>
            )}
            {isSignUp && (
              <div>
                <label className="mb-1 block text-[11px] font-medium text-zinc-400">
                  Name
                </label>
                <Input
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            )}
            <div>
              <label className="mb-1 block text-[11px] font-medium text-zinc-400">
                Email
              </label>
              <Input
                placeholder="you@company.com"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-zinc-400">
                Password
              </label>
              <Input
                placeholder="••••••••"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={pending}>
              {pending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              {pending ? "Working…" : hasWorkspace ? (isSignUp ? "Create account" : "Sign in") : "Create workspace"}
            </Button>
          </form>

          {hasWorkspace && (
            <div className="mt-4 text-center">
              <button
                className="text-xs text-zinc-400 transition hover:text-zinc-200"
                type="button"
                onClick={() => setIsSignUp((v) => !v)}
              >
                {isSignUp ? "Already have an account? Sign in" : "Need an account? Sign up"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
