"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityTimeline, type AuditRow } from "@/components/activity-timeline";

type Actor = { actorId: string; displayName: string; actorType: string };
type Channel = { id: string; name: string };

export default function AdminActivityPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterActor, setFilterActor] = useState<string>("");
  const [limit, setLimit] = useState<number>(100);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterActor) params.set("actorId", filterActor);
      params.set("limit", String(limit));
      const [auditRes, actorsRes, channelsRes] = await Promise.all([
        fetch(`/api/admin/audit?${params.toString()}`, { cache: "no-store" }),
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
  }, [filterActor, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  return (
    <section className="mx-auto max-w-5xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Activity</h2>
        <p className="mt-1 text-sm text-zinc-400">
          The per-org hash-chained audit log. Filter by actor to see exactly what one principal did.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3">
        <label className="min-w-[240px] flex-1 text-[11px] text-zinc-400">
          <span className="mb-1 block">Actor</span>
          <select
            value={filterActor}
            onChange={(event) => setFilterActor(event.target.value)}
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-100 outline-none transition focus:border-emerald-500/60"
          >
            <option value="">Everyone</option>
            {actors.map((a) => (
              <option key={a.actorId} value={a.actorId}>
                {a.displayName} · {a.actorType} · {a.actorId.slice(0, 8)}…
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-zinc-400">
          <span className="mb-1 block">Limit</span>
          <select
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-100 outline-none transition focus:border-emerald-500/60"
          >
            {[50, 100, 200, 500].map((n) => (
              <option key={n} value={n}>
                Last {n}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}

      {loading && rows.length === 0 ? (
        <p className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-xs text-zinc-500">
          Loading audit log…
        </p>
      ) : (
        <ActivityTimeline
          rows={rows}
          actorsById={actorsById}
          channelsById={channelsById}
          emptyLabel={filterActor ? "No activity for this actor yet." : "No audit entries yet."}
        />
      )}
    </section>
  );
}
