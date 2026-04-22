"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  Bot,
  Eye,
  EyeOff,
  Activity,
  ShieldBan,
  Trash2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";

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
      `Revoke every live grant held by ${displayName}?\n\nThe agent will be denied on its next action.`,
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
            ? `${displayName} had no live grants.`
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
          note: approve ? "approved via admin" : "denied via admin",
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
    const confirmed = window.confirm(`Revoke ${capability} grant now?`);
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
    <section className="mx-auto max-w-5xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Agents</h2>
          <p className="mt-1 text-xs text-zinc-400">
            Manage non-human actors, their grants, and join requests.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {toast && (
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-xs",
            toast.type === "ok"
              ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
              : "border-red-500/30 bg-red-500/5 text-red-300",
          )}
        >
          {toast.message}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {/* Join requests */}
      {joinRequests.length > 0 && (
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/20">
          <div className="border-b border-zinc-800/40 px-4 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">
              Pending join requests ({joinRequests.length})
            </p>
          </div>
          <div className="divide-y divide-zinc-800/40">
            {joinRequests.map((request) => (
              <div key={request.requestId} className="flex items-center gap-3 px-4 py-3">
                <Avatar name={request.displayName} type="agent" size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-zinc-100">{request.displayName}</p>
                  <p className="text-[10px] text-zinc-500">
                    {new Date(request.createdAt).toISOString().slice(0, 19).replace("T", " ")}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    disabled={resolveJoinPending[request.requestId]}
                    onClick={() => void resolveJoinRequest(request.requestId, true)}
                  >
                    <CheckCircle2 className="mr-1 h-3 w-3" />
                    Approve
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={resolveJoinPending[request.requestId]}
                    onClick={() => void resolveJoinRequest(request.requestId, false)}
                  >
                    <XCircle className="mr-1 h-3 w-3" />
                    Deny
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent list */}
      <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/20">
        {loading && agents.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-zinc-500">Loading…</div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-8 text-center">
            <Bot className="mb-2 h-8 w-8 text-zinc-600" />
            <p className="text-sm text-zinc-400">No agents yet.</p>
            <p className="mt-1 text-xs text-zinc-500">
              Run an agent client to see it appear here.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/40">
            {sorted.map((agent) => {
              const isExpanded = expandedByActor[agent.actorId];
              const grants = grantsByActor[agent.actorId];
              return (
                <Fragment key={agent.actorId}>
                  <div className="flex items-center gap-3 px-4 py-3">
                    <Avatar name={agent.displayName} type={agent.actorType} size="md" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-zinc-100">{agent.displayName}</p>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-500">
                        <Badge variant="indigo">{agent.actorType}</Badge>
                        <span className="font-mono">{agent.actorId.slice(0, 12)}…</span>
                        <span>{new Date(agent.createdAt).toISOString().slice(0, 10)}</span>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void toggleAgentGrants(agent.actorId)}
                        className="gap-1"
                      >
                        {isExpanded ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                        {isExpanded ? "Hide" : "Grants"}
                      </Button>
                      <Link href={`/admin/agents/${agent.actorId}`}>
                        <Button variant="outline" size="sm" className="gap-1">
                          <Activity className="h-3.5 w-3.5" />
                          Activity
                        </Button>
                      </Link>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={kickPending[agent.actorId]}
                        onClick={() => void kick(agent.actorId, agent.displayName)}
                      >
                        <ShieldBan className="mr-1 h-3.5 w-3.5" />
                        {kickPending[agent.actorId] ? "…" : "Kick"}
                      </Button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="bg-zinc-900/10 px-4 py-3 pl-16">
                      {grantsLoadingByActor[agent.actorId] ? (
                        <p className="text-xs text-zinc-500">Loading grants…</p>
                      ) : grantsErrorByActor[agent.actorId] ? (
                        <p className="text-xs text-red-300">{grantsErrorByActor[agent.actorId]}</p>
                      ) : (grants ?? []).length === 0 ? (
                        <p className="text-xs text-zinc-500">No active grants.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {(grants ?? []).map((grant) => (
                            <div
                              key={grant.grantId}
                              className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/40 bg-zinc-950/40 px-3 py-2 text-xs"
                            >
                              <div className="min-w-0">
                                <p className="font-medium text-zinc-200">
                                  {grant.capability}
                                  <span className="ml-2 text-zinc-500">
                                    on {grant.resourceType}
                                    {grant.resourceId ? `:${grant.resourceId.slice(0, 8)}…` : ":*"}
                                  </span>
                                </p>
                                <p className="mt-0.5 text-zinc-500">
                                  {formatGrantDuration(grant)}
                                  {grant.maxUses !== null
                                    ? ` · ${grant.usesCount}/${grant.maxUses} used`
                                    : ""}
                                </p>
                              </div>
                              <Button
                                variant="destructive"
                                size="sm"
                                disabled={revokeGrantPending[grant.grantId]}
                                onClick={() =>
                                  void revokeSingleGrant(
                                    agent.actorId,
                                    grant.grantId,
                                    grant.capability,
                                  )
                                }
                                className="h-7 text-[10px]"
                              >
                                <Trash2 className="mr-1 h-3 w-3" />
                                {revokeGrantPending[grant.grantId] ? "…" : "Revoke"}
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
