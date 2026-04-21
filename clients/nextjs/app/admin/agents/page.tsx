"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

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
type AgentGrantRow = {
  grantId: string;
  actorId: string;
  resourceType: string;
  resourceId: string | null;
  capability: string;
  expiresAt: string | null;
  maxUses: number | null;
  usesCount: number;
  remainingUses: number | null;
  constraints: Record<string, unknown>;
  createdAt: string;
  createdByActorId: string;
};

function formatGrantDuration(grant: AgentGrantRow): string {
  if (grant.expiresAt) {
    const until = new Date(grant.expiresAt);
    if (!Number.isNaN(until.getTime())) {
      return `until ${until.toISOString().slice(0, 19)}Z`;
    }
  }
  if (grant.maxUses !== null) {
    return `${grant.remainingUses ?? 0} use${(grant.remainingUses ?? 0) === 1 ? "" : "s"} left`;
  }
  return "until revoked";
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joinRequests, setJoinRequests] = useState<AgentJoinRequest[]>([]);
  const [kickPending, setKickPending] = useState<Record<string, boolean>>({});
  const [resolveJoinPending, setResolveJoinPending] = useState<Record<string, boolean>>({});
  const [expandedByActor, setExpandedByActor] = useState<Record<string, boolean>>({});
  const [grantsByActor, setGrantsByActor] = useState<Record<string, AgentGrantRow[]>>({});
  const [grantsLoadingByActor, setGrantsLoadingByActor] = useState<Record<string, boolean>>({});
  const [grantsErrorByActor, setGrantsErrorByActor] = useState<Record<string, string | null>>({});
  const [revokeGrantPending, setRevokeGrantPending] = useState<Record<string, boolean>>({});
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

  async function loadAgentGrants(actorId: string) {
    setGrantsLoadingByActor((prev) => ({ ...prev, [actorId]: true }));
    try {
      const res = await fetch(`/api/admin/agents/${actorId}/grants`, { cache: "no-store" });
      const body = (await res.json()) as { grants?: AgentGrantRow[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setGrantsByActor((prev) => ({ ...prev, [actorId]: body.grants ?? [] }));
      setGrantsErrorByActor((prev) => ({ ...prev, [actorId]: null }));
    } catch (err) {
      setGrantsErrorByActor((prev) => ({
        ...prev,
        [actorId]: (err as Error).message,
      }));
    } finally {
      setGrantsLoadingByActor((prev) => ({ ...prev, [actorId]: false }));
    }
  }

  async function toggleAgentGrants(actorId: string) {
    const next = !expandedByActor[actorId];
    setExpandedByActor((prev) => ({ ...prev, [actorId]: next }));
    if (next && grantsByActor[actorId] === undefined) {
      await loadAgentGrants(actorId);
    }
  }

  async function revokeSingleGrant(actorId: string, grantId: string, capability: string) {
    const confirmed = window.confirm(
      `Revoke ${capability} grant now?\n\nThe agent loses access immediately and can request approval again on next action.`,
    );
    if (!confirmed) return;
    setRevokeGrantPending((prev) => ({ ...prev, [grantId]: true }));
    setToast(null);
    try {
      const res = await fetch(`/api/admin/grants/${grantId}/revoke`, { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setGrantsByActor((prev) => ({
        ...prev,
        [actorId]: (prev[actorId] ?? []).filter((grant) => grant.grantId !== grantId),
      }));
      setToast({ type: "ok", message: `Revoked ${capability}.` });
    } catch (err) {
      setToast({ type: "err", message: (err as Error).message });
    } finally {
      setRevokeGrantPending((prev) => ({ ...prev, [grantId]: false }));
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
                <th className="px-4 py-2 text-left">Capabilities</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((agent) => (
                <Fragment key={agent.actorId}>
                  <tr className="border-b border-zinc-900/80">
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
                    <td className="px-4 py-3 text-xs text-zinc-300">
                      {grantsByActor[agent.actorId] ? (
                        <span>
                          {grantsByActor[agent.actorId]?.length ?? 0} active grant
                          {(grantsByActor[agent.actorId]?.length ?? 0) === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <span className="text-zinc-500">Not loaded</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => void toggleAgentGrants(agent.actorId)}
                          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800"
                        >
                          {expandedByActor[agent.actorId] ? "Hide access" : "Show access"}
                        </button>
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
                  {expandedByActor[agent.actorId] ? (
                    <tr className="border-b border-zinc-900/80 last:border-0">
                      <td colSpan={6} className="bg-zinc-900/20 px-4 py-3">
                        {grantsLoadingByActor[agent.actorId] ? (
                          <p className="text-xs text-zinc-500">Loading active capabilities…</p>
                        ) : grantsErrorByActor[agent.actorId] ? (
                          <p className="text-xs text-red-300">{grantsErrorByActor[agent.actorId]}</p>
                        ) : (grantsByActor[agent.actorId] ?? []).length === 0 ? (
                          <p className="text-xs text-zinc-500">No active grants.</p>
                        ) : (
                          <div className="space-y-2">
                            {(grantsByActor[agent.actorId] ?? []).map((grant) => (
                              <div
                                key={grant.grantId}
                                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs"
                              >
                                <div className="min-w-0">
                                  <p className="font-medium text-zinc-100">
                                    {grant.capability}
                                    <span className="ml-2 text-zinc-500">
                                      on {grant.resourceType}
                                      {grant.resourceId ? `:${grant.resourceId.slice(0, 8)}…` : ":*"}
                                    </span>
                                  </p>
                                  <p className="mt-1 text-zinc-400">
                                    Access: {formatGrantDuration(grant)}
                                    {grant.maxUses !== null
                                      ? ` · used ${grant.usesCount}/${grant.maxUses}`
                                      : ""}
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  disabled={revokeGrantPending[grant.grantId]}
                                  onClick={() =>
                                    void revokeSingleGrant(
                                      agent.actorId,
                                      grant.grantId,
                                      grant.capability,
                                    )
                                  }
                                  className="rounded-md border border-red-700/80 bg-red-700/20 px-2.5 py-1 text-[11px] font-medium text-red-100 transition hover:bg-red-700/40 disabled:opacity-50"
                                >
                                  {revokeGrantPending[grant.grantId] ? "Revoking…" : "Revoke"}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
