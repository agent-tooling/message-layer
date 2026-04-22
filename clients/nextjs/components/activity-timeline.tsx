"use client";

import { useState } from "react";

export type AuditRow = {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  prevHash: string | null;
  eventHash: string;
  createdAt: string;
};

type Props = {
  rows: AuditRow[];
  actorsById: Record<string, { displayName: string; actorType: string }>;
  channelsById: Record<string, { name: string }>;
  emptyLabel?: string;
};

/**
 * Renders the per-org audit log as a human-readable timeline. Each entry
 * becomes one line with a short headline + expandable raw payload, so
 * operators can see what happened at a glance without parsing JSON.
 */
export function ActivityTimeline({ rows, actorsById, channelsById, emptyLabel }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-xs text-zinc-500">
        {emptyLabel ?? "No audit entries yet."}
      </p>
    );
  }

  const ordered = [...rows].reverse();

  return (
    <ol className="space-y-2">
      {ordered.map((row) => {
        const isOpen = open[row.id] ?? false;
        const { icon, summary, tone } = describe(row, actorsById, channelsById);
        return (
          <li
            key={row.id}
            className="rounded-xl border border-zinc-800/80 bg-zinc-900/60 transition hover:border-zinc-700"
          >
            <button
              type="button"
              className="flex w-full items-start gap-3 px-3 py-2 text-left"
              onClick={() => setOpen((prev) => ({ ...prev, [row.id]: !prev[row.id] }))}
            >
              <span
                className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${tone}`}
              >
                {icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-zinc-200">
                  <span className="font-medium">{summary}</span>
                  <code className="rounded bg-zinc-800/80 px-1 py-0.5 text-[10px] text-zinc-400">
                    {row.eventType}
                  </code>
                </div>
                <p className="mt-0.5 text-[10px] tabular-nums text-zinc-500">{formatTs(row.createdAt)}</p>
              </div>
              <span className="mt-0.5 text-[10px] text-zinc-500">{isOpen ? "▲" : "▼"}</span>
            </button>

            {isOpen ? (
              <div className="border-t border-zinc-800/80 bg-zinc-950/70 px-3 py-2">
                <pre className="overflow-x-auto text-[11px] leading-relaxed text-zinc-300">
                  {JSON.stringify(row.payload, null, 2)}
                </pre>
                <div className="mt-2 grid gap-1 text-[10px] text-zinc-500">
                  <span>
                    <span className="text-zinc-400">event hash:</span> {row.eventHash}
                  </span>
                  {row.prevHash ? (
                    <span>
                      <span className="text-zinc-400">prev hash:</span> {row.prevHash}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace("T", " ").replace("Z", " UTC");
  } catch {
    return iso;
  }
}

function describe(
  row: AuditRow,
  actorsById: Record<string, { displayName: string; actorType: string }>,
  channelsById: Record<string, { name: string }>,
): { icon: string; summary: string; tone: string } {
  const p = row.payload;
  const actor = (id?: unknown) => {
    if (typeof id !== "string") return null;
    return actorsById[id]?.displayName ?? `${id.slice(0, 10)}…`;
  };
  const channel = (id?: unknown) => {
    if (typeof id !== "string") return null;
    return channelsById[id]?.name ? `#${channelsById[id].name}` : `${id.slice(0, 10)}…`;
  };

  switch (row.eventType) {
    case "org.created":
      return { icon: "org", summary: `Org created: ${String(p.name ?? "")}`, tone: "bg-zinc-800 text-zinc-300" };
    case "channel.created":
      return {
        icon: "#",
        summary: `Channel #${String(p.name ?? "?")} created by ${actor(p.createdByActorId) ?? "?"}`,
        tone: "bg-emerald-500/20 text-emerald-200",
      };
    case "thread.created":
      return {
        icon: "⇢",
        summary: `Thread created in ${channel(p.channelId) ?? "?"} by ${actor(p.createdByActorId) ?? "?"}`,
        tone: "bg-emerald-500/10 text-emerald-200",
      };
    case "message.appended": {
      const partCount = Number(p.partCount ?? 0);
      return {
        icon: "✎",
        summary: `Message from ${actor(p.actorId) ?? "?"} in ${channel(p.streamId) ?? "?"} (${partCount} part${
          partCount === 1 ? "" : "s"
        })`,
        tone: "bg-sky-500/15 text-sky-200",
      };
    }
    case "message.redacted":
      return {
        icon: "⌫",
        summary: `Message redacted in ${channel(p.streamId) ?? "?"} by ${actor(p.redactedByActorId) ?? "?"}`,
        tone: "bg-red-500/15 text-red-200",
      };
    case "membership.updated": {
      const role = typeof p.role === "string" ? p.role : p.role === null ? "removed" : "member";
      return {
        icon: "👥",
        summary: `Membership update: ${actor(p.actorId) ?? "?"} → ${role}${
          typeof p.channelId === "string" ? ` in ${channel(p.channelId)}` : ""
        }`,
        tone: "bg-zinc-800 text-zinc-300",
      };
    }
    case "grant.created":
      return {
        icon: "🔑",
        summary: `Grant issued: ${String(p.capability ?? "?")} → ${actor(p.actorId) ?? "?"}${
          p.maxUses ? ` (maxUses: ${p.maxUses})` : ""
        }${p.expiresAt ? ` (exp: ${String(p.expiresAt).slice(0, 19)}Z)` : ""}`,
        tone: "bg-emerald-600/20 text-emerald-200",
      };
    case "grant.revoked":
      return {
        icon: "⛔",
        summary:
          p.autoRevoked === true
            ? `Grant auto-revoked (${String(p.reason ?? "exhausted")})`
            : `Grant revoked${p.reason ? ` (${String(p.reason)})` : ""}${
                p.bulk === true ? ", bulk" : ""
              }`,
        tone: "bg-red-500/20 text-red-200",
      };
    case "permission_request.created":
      return {
        icon: "?!",
        summary: `${actor(p.actorId) ?? "?"} requested ${String(p.action ?? "?")}`,
        tone: "bg-amber-500/20 text-amber-200",
      };
    case "permission_request.resolved": {
      const status = String(p.status ?? "?");
      const tail =
        status === "approved" && (p.maxUses || p.expiresAt)
          ? ` (${p.maxUses ? `maxUses=${p.maxUses}` : ""}${p.maxUses && p.expiresAt ? ", " : ""}${
              p.expiresAt ? `exp=${String(p.expiresAt).slice(0, 19)}Z` : ""
            })`
          : "";
      return {
        icon: status === "approved" ? "✓" : "✗",
        summary: `Request ${status} by ${actor(p.resolverActorId) ?? "?"}${tail}`,
        tone: status === "approved" ? "bg-emerald-500/20 text-emerald-200" : "bg-red-500/20 text-red-200",
      };
    }
    case "artifact.registered":
      return {
        icon: "📎",
        summary: `Artifact ${String(p.filename ?? "?")} uploaded by ${actor(p.createdByActorId) ?? "?"}`,
        tone: "bg-indigo-500/20 text-indigo-200",
      };
    case "artifact.deleted":
      return {
        icon: "🗑",
        summary: `Artifact deleted by ${actor(p.deletedByActorId) ?? "?"}`,
        tone: "bg-red-500/20 text-red-200",
      };
    case "memory.promoted":
      return {
        icon: "★",
        summary: `Memory promoted by ${actor(p.promotedByActorId) ?? "?"}`,
        tone: "bg-yellow-500/20 text-yellow-200",
      };
    case "cursor.updated":
      return {
        icon: "→",
        summary: `${actor(p.actorId) ?? "?"} caught up in ${channel(p.streamId) ?? "?"}`,
        tone: "bg-zinc-800 text-zinc-400",
      };
    case "client.registered":
      return {
        icon: "📡",
        summary: `Client registered by ${actor(p.actorId) ?? "?"}`,
        tone: "bg-zinc-800 text-zinc-300",
      };
    default:
      return {
        icon: "·",
        summary: row.eventType,
        tone: "bg-zinc-800 text-zinc-400",
      };
  }
}
