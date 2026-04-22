"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ActivityTimeline, type AuditRow } from "@/components/activity-timeline";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

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
    <section className="mx-auto max-w-5xl space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Activity</h2>
        <p className="mt-1 text-xs text-zinc-400">
          Hash-chained audit log. Filter by actor to inspect a specific principal.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-800/60 bg-zinc-900/20 p-3">
        <label className="min-w-[200px] flex-1 text-[11px] text-zinc-400">
          <span className="mb-1 block font-medium">Actor</span>
          <Select
            value={filterActor}
            onChange={(e) => setFilterActor(e.target.value)}
            className="text-xs"
          >
            <option value="">Everyone</option>
            {actors.map((a) => (
              <option key={a.actorId} value={a.actorId}>
                {a.displayName} · {a.actorType}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-[11px] text-zinc-400">
          <span className="mb-1 block font-medium">Limit</span>
          <Select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="w-24 text-xs"
          >
            {[50, 100, 200, 500].map((n) => (
              <option key={n} value={n}>
                Last {n}
              </option>
            ))}
          </Select>
        </label>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/20 px-4 py-8 text-center text-sm text-zinc-500">
          Loading audit log…
        </div>
      ) : (
        <ActivityTimeline
          rows={rows}
          actorsById={actorsById}
          channelsById={channelsById}
          emptyLabel={filterActor ? "No activity for this actor." : "No audit entries yet."}
        />
      )}
    </section>
  );
}
