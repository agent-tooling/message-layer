"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityTimeline, type AuditRow } from "@/components/activity-timeline";

type Actor = { actorId: string; displayName: string; actorType: string; createdAt: string };
type Channel = { id: string; name: string; visibility: string };

export default function AgentActivityPage() {
  const params = useParams<{ actorId: string }>();
  const actorId = params?.actorId ?? "";
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kickPending, setKickPending] = useState(false);
  const [toast, setToast] = useState<{ type: "ok" | "err"; message: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!actorId) return;
    setLoading(true);
    try {
      const [auditRes, actorsRes, channelsRes] = await Promise.all([
        fetch(`/api/admin/audit?actorId=${encodeURIComponent(actorId)}&limit=500`, { cache: "no-store" }),
        fetch("/api/team/actors", { cache: "no-store" }),
        fetch("/api/team/channels", { cache: "no-store" }),
      ]);
      const auditBody = (await auditRes.json()) as { rows?: AuditRow[]; error?: string };
      if (!auditRes.ok) throw new Error(auditBody.error ?? `HTTP ${auditRes.status}`);
      const actorsBody = (await actorsRes.json()) as { actors?: Actor[]; error?: string };
      if (!actorsRes.ok) throw new Error(actorsBody.error ?? `HTTP ${actorsRes.status}`);
      const channelsBody = (await channelsRes.json()) as { channels?: Channel[]; error?: string };
      if (!channelsRes.ok) throw new Error(channelsBody.error ?? `HTTP ${channelsRes.status}`);
      setRows(auditBody.rows ?? []);
      setActors(actorsBody.actors ?? []);
      setChannels(channelsBody.channels ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [actorId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const actor = useMemo(() => actors.find((a) => a.actorId === actorId), [actors, actorId]);
  const actorsById = useMemo(() => {
    const map: Record<string, { displayName: string; actorType: string }> = {};
    for (const a of actors) map[a.actorId] = { displayName: a.displayName, actorType: a.actorType };
    return map;
  }, [actors]);
  const channelsById = useMemo(() => {
    const map: Record<string, { name: string }> = {};
    for (const c of channels) map[c.id] = { name: c.name };
    return map;
  }, [channels]);

  const stats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.eventType, (counts.get(row.eventType) ?? 0) + 1);
    return [...counts.entries()].sort(([, a], [, b]) => b - a);
  }, [rows]);

  async function kick() {
    if (!actor) return;
    const confirmed = window.confirm(
      `Revoke every live grant held by ${actor.displayName}?\n\nThis emits one grant.revoked audit event per affected grant. The agent will be denied on its next action.`,
    );
    if (!confirmed) return;
    setKickPending(true);
    setToast(null);
    try {
      const res = await fetch(`/api/admin/agents/${actor.actorId}/kick`, {
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
            ? `${actor.displayName} had no live grants — nothing to revoke.`
            : `Revoked ${count} grant${count === 1 ? "" : "s"}.`,
      });
      await refresh();
    } catch (err) {
      setToast({ type: "err", message: (err as Error).message });
    } finally {
      setKickPending(false);
    }
  }

  return (
    <section className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link href="/admin/agents" className="text-xs text-zinc-500 hover:text-zinc-300">
            ← All agents
          </Link>
          <h2 className="mt-2 text-lg font-semibold tracking-tight">
            {actor ? actor.displayName : actorId.slice(0, 16) + "…"}
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            <span className="font-mono">{actorId}</span>
            {actor ? ` · ${actor.actorType} · created ${new Date(actor.createdAt).toISOString().slice(0, 19)}Z` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800"
          >
            Refresh
          </button>
          <button
            type="button"
            disabled={kickPending || !actor || actor.actorType !== "agent"}
            onClick={() => void kick()}
            className="rounded-md border border-red-700/80 bg-red-700/20 px-3 py-1.5 text-xs font-medium text-red-100 transition hover:bg-red-700/40 disabled:opacity-40"
            title={
              !actor
                ? "loading…"
                : actor.actorType !== "agent"
                  ? "Only agents can be kicked"
                  : "Revoke all live grants for this agent"
            }
          >
            {kickPending ? "Kicking…" : "Kick agent"}
          </button>
        </div>
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

      {stats.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-3 md:grid-cols-5">
          {stats.slice(0, 5).map(([type, count]) => (
            <div
              key={type}
              className="rounded-xl border border-zinc-800/80 bg-zinc-900/60 px-3 py-2 text-xs"
            >
              <p className="text-[10px] uppercase tracking-wide text-zinc-500">{type}</p>
              <p className="mt-1 text-xl font-semibold text-zinc-100 tabular-nums">{count}</p>
            </div>
          ))}
        </div>
      ) : null}

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-zinc-400">Activity</h3>
        {loading && rows.length === 0 ? (
          <p className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-xs text-zinc-500">
            Loading audit log…
          </p>
        ) : (
          <ActivityTimeline
            rows={rows}
            actorsById={actorsById}
            channelsById={channelsById}
            emptyLabel="No activity for this actor yet."
          />
        )}
      </div>
    </section>
  );
}
