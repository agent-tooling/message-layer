"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

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
      <div className="mx-auto mt-16 w-full max-w-md rounded-2xl border border-zinc-800/80 bg-zinc-950/80 p-8 text-sm text-zinc-300 shadow-2xl shadow-black/40 backdrop-blur">
        Loading setup...
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 w-full max-w-md rounded-2xl border border-zinc-800/80 bg-zinc-950/80 p-8 shadow-2xl shadow-black/40 backdrop-blur">
      <div className="mb-6">
        <p className="mb-2 text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Message Layer Team Client</p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {hasWorkspace ? (isSignUp ? "Create account" : "Sign in") : "Create workspace"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          {hasWorkspace
            ? "Authenticate with Better Auth to join your workspace, channels, and agent onboarding controls."
            : "Set the workspace name and create the first admin account."}
        </p>
      </div>
      <form className="space-y-3" onSubmit={onSubmit}>
        {!hasWorkspace ? (
          <input
            className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-3 py-2.5 text-sm outline-none transition focus:border-emerald-500/70"
            placeholder="Workspace name"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            required
          />
        ) : null}
        {isSignUp ? (
          <input
            className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-3 py-2.5 text-sm outline-none transition focus:border-emerald-500/70"
            placeholder="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        ) : null}
        <input
          className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-3 py-2.5 text-sm outline-none transition focus:border-emerald-500/70"
          placeholder="Email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <input
          className="w-full rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-3 py-2.5 text-sm outline-none transition focus:border-emerald-500/70"
          placeholder="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <button
          type="submit"
          className="w-full rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-60"
          disabled={pending}
        >
          {pending ? "Working..." : hasWorkspace ? (isSignUp ? "Create account" : "Sign in") : "Create workspace"}
        </button>
      </form>
      {hasWorkspace ? (
        <button
          className="mt-5 text-sm text-zinc-300 underline underline-offset-4"
          type="button"
          onClick={() => setIsSignUp((value) => !value)}
        >
          {isSignUp ? "Already have an account? Sign in" : "Need an account? Sign up"}
        </button>
      ) : null}
    </div>
  );
}
