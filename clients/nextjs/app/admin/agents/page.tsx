"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type AgentRow = {
  actorId: string;
  displayName: string;
  actorType: string;
  createdAt: string;
};
type AgentJoinRequest = {
  requestId: string;
  displayName: string;
  orgId: string;
  status: "open";
  createdAt: string;
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joinRequests, setJoinRequests] = useState<AgentJoinRequest[]>([]);
  const [kickPending, setKickPending] = useState<Record<string, boolean>>({});
  const [resolveJoinPending, setResolveJoinPending] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<{ type: "ok" | "err"; message: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [agentRes, requestRes] = await Promise.all([
        fetch("/api/team/agents", { cache: "no-store" }),
        fetch("/api/team/agents/join-requests", { cache: "no-store" }),
      ]);
      const body = (await agentRes.json()) as { agents?: AgentRow[]; error?: string };
      if (!agentRes.ok) throw new Error(body.error ?? `HTTP ${agentRes.status}`);
      const requestsBody = (await requestRes.json()) as {
        requests?: AgentJoinRequest[];
        error?: string;
      };
      if (!requestRes.ok) throw new Error(requestsBody.error ?? `HTTP ${requestRes.status}`);
      setAgents(body.agents ?? []);
      setJoinRequests(requestsBody.requests ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sorted = useMemo(
    () =>
      [...agents].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [agents],
  );

  async function kick(actorId: string, displayName: string) {
    const confirmed = window.confirm(
      `Revoke every live grant held by ${displayName}?\n\nThe agent will be denied on its next action. Each grant emits a grant.revoked event in the audit log.`,
    );
    if (!confirmed) return;
    setKickPending((prev) => ({ ...prev, [actorId]: true }));
    setToast(null);
    try {
      const res = await fetch(`/api/admin/agents/${actorId}/kick`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "kicked from admin UI" }),
      });
      const body = (await res.json()) as { revokedGrantIds?: string[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const count = body.revokedGrantIds?.length ?? 0;
      setToast({
        type: "ok",
        message:
          count === 0
            ? `${displayName} had no live grants — nothing to revoke.`
            : `Revoked ${count} grant${count === 1 ? "" : "s"} from ${displayName}.`,
      });
    } catch (err) {
      setToast({ type: "err", message: (err as Error).message });
    } finally {
      setKickPending((prev) => ({ ...prev, [actorId]: false }));
    }
  }

  async function resolveJoinRequest(requestId: string, approve: boolean) {
    setResolveJoinPending((prev) => ({ ...prev, [requestId]: true }));
    setToast(null);
    try {
      const res = await fetch(`/api/team/agents/join-requests/${requestId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          approve,
          note: approve ? "approved via admin agents page" : "denied via admin agents page",
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setToast({
        type: "ok",
        message: approve ? "Agent join request approved." : "Agent join request denied.",
      });
      await refresh();
    } catch (err) {
      setToast({ type: "err", message: (err as Error).message });
    } finally {
      setResolveJoinPending((prev) => ({ ...prev, [requestId]: false }));
    }
  }

  return (
    <section className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Agents</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Every non-human actor in this workspace. Kick an agent to revoke every live grant it
            currently holds in one call; its next action will hit the deny path.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>

      {toast ? (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            toast.type === "ok"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/40 bg-red-500/10 text-red-200"
          }`}
        >
          {toast.message}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-950/60">
        <div className="border-b border-zinc-800 bg-zinc-900/60 px-4 py-2 text-[10px] uppercase tracking-wider text-zinc-400">
          Pending agent join requests
        </div>
        {joinRequests.length === 0 ? (
          <div className="px-4 py-4 text-xs text-zinc-500">No pending join requests.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-900/30 text-[10px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-4 py-2 text-left">Display name</th>
                <th className="px-4 py-2 text-left">Request id</th>
                <th className="px-4 py-2 text-left">Created</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {joinRequests.map((request) => (
                <tr key={request.requestId} className="border-b border-zinc-900/80 last:border-0">
                  <td className="px-4 py-3 font-medium text-zinc-100">{request.displayName}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-zinc-500">
                    {request.requestId.slice(0, 16)}…
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-400">
                    {new Date(request.createdAt).toISOString().slice(0, 19).replace("T", " ")}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        disabled={resolveJoinPending[request.requestId]}
                        onClick={() => void resolveJoinRequest(request.requestId, true)}
                        className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={resolveJoinPending[request.requestId]}
                        onClick={() => void resolveJoinRequest(request.requestId, false)}
                        className="rounded-md border border-red-700 bg-red-700/30 px-3 py-1 text-xs font-semibold text-red-100 transition hover:bg-red-700/50 disabled:opacity-50"
                      >
                        Deny
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-950/60">
        {loading && agents.length === 0 ? (
          <div className="px-4 py-6 text-sm text-zinc-500">Loading…</div>
        ) : sorted.length === 0 ? (
          <div className="px-4 py-6 text-sm text-zinc-500">
            No agents yet. Run <code className="rounded bg-zinc-900 px-1.5 py-0.5 text-xs">pnpm run agent:poet</code>{" "}
            (or any MCP/agent-auth client) and one will appear here.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-900/60 text-[10px] uppercase tracking-wider text-zinc-400">
              <tr>
                <th className="px-4 py-2 text-left">Agent</th>
                <th className="px-4 py-2 text-left">Id</th>
                <th className="px-4 py-2 text-left">Type</th>
                <th className="px-4 py-2 text-left">Created</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((agent) => (
                <tr key={agent.actorId} className="border-b border-zinc-900/80 last:border-0">
                  <td className="px-4 py-3 font-medium text-zinc-100">{agent.displayName}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-zinc-500">
                    {agent.actorId.slice(0, 16)}…
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span className="rounded bg-indigo-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-indigo-200">
                      {agent.actorType}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-400">
                    {new Date(agent.createdAt).toISOString().slice(0, 19).replace("T", " ")}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <Link
                        href={`/admin/agents/${agent.actorId}`}
                        className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-200 transition hover:border-emerald-600/70 hover:text-emerald-200"
                      >
                        View activity
                      </Link>
                      <button
                        type="button"
                        disabled={kickPending[agent.actorId]}
                        onClick={() => void kick(agent.actorId, agent.displayName)}
                        className="rounded-md border border-red-700/80 bg-red-700/20 px-3 py-1 text-xs font-medium text-red-100 transition hover:bg-red-700/40 disabled:opacity-50"
                      >
                        {kickPending[agent.actorId] ? "Kicking…" : "Kick"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
