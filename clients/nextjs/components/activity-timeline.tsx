"use client";

import { useState } from "react";
import {
  Hash,
  MessageSquare,
  Key,
  ShieldBan,
  ShieldQuestion,
  ShieldCheck,
  XCircle,
  Paperclip,
  Trash2,
  Star,
  ArrowRight,
  Radio,
  Users,
  Building2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

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

export function ActivityTimeline({ rows, actorsById, channelsById, emptyLabel }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-xl border border-zinc-800/60 bg-zinc-900/20 px-4 py-8 text-center">
        <p className="text-sm text-zinc-500">
          {emptyLabel ?? "No audit entries yet."}
        </p>
      </div>
    );
  }

  const ordered = [...rows].reverse();

  return (
    <div className="space-y-1">
      {ordered.map((row) => {
        const isOpen = open[row.id] ?? false;
        const { icon: Icon, summary, tone } = describe(row, actorsById, channelsById);
        return (
          <div
            key={row.id}
            className="rounded-lg border border-zinc-800/40 bg-zinc-900/20 transition hover:border-zinc-700/50"
          >
            <button
              type="button"
              className="flex w-full items-center gap-3 px-3 py-2 text-left"
              onClick={() => setOpen((prev) => ({ ...prev, [row.id]: !prev[row.id] }))}
            >
              <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full", tone)}>
                <Icon className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-zinc-200">{summary}</span>
                  <Badge variant="secondary">{row.eventType}</Badge>
                </div>
                <p className="mt-0.5 text-[10px] tabular-nums text-zinc-600">{formatTs(row.createdAt)}</p>
              </div>
              {isOpen ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
              )}
            </button>

            {isOpen && (
              <div className="border-t border-zinc-800/40 bg-zinc-950/40 px-3 py-2.5">
                <pre className="overflow-x-auto text-[11px] leading-relaxed text-zinc-400">
                  {JSON.stringify(row.payload, null, 2)}
                </pre>
                <div className="mt-2 space-y-0.5 text-[10px] text-zinc-600">
                  <p>
                    <span className="text-zinc-500">hash:</span> {row.eventHash}
                  </p>
                  {row.prevHash && (
                    <p>
                      <span className="text-zinc-500">prev:</span> {row.prevHash}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
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

type IconComponent = typeof Hash;

function describe(
  row: AuditRow,
  actorsById: Record<string, { displayName: string; actorType: string }>,
  channelsById: Record<string, { name: string }>,
): { icon: IconComponent; summary: string; tone: string } {
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
      return { icon: Building2, summary: `Org created: ${String(p.name ?? "")}`, tone: "bg-zinc-800 text-zinc-300" };
    case "channel.created":
      return {
        icon: Hash,
        summary: `#${String(p.name ?? "?")} created by ${actor(p.createdByActorId) ?? "?"}`,
        tone: "bg-emerald-500/15 text-emerald-300",
      };
    case "thread.created":
      return {
        icon: MessageSquare,
        summary: `Thread in ${channel(p.channelId) ?? "?"} by ${actor(p.createdByActorId) ?? "?"}`,
        tone: "bg-emerald-500/10 text-emerald-300",
      };
    case "message.appended": {
      const partCount = Number(p.partCount ?? 0);
      return {
        icon: MessageSquare,
        summary: `${actor(p.actorId) ?? "?"} → ${channel(p.streamId) ?? "?"} (${partCount} part${partCount === 1 ? "" : "s"})`,
        tone: "bg-sky-500/15 text-sky-300",
      };
    }
    case "message.redacted":
      return {
        icon: Trash2,
        summary: `Message redacted in ${channel(p.streamId) ?? "?"} by ${actor(p.redactedByActorId) ?? "?"}`,
        tone: "bg-red-500/15 text-red-300",
      };
    case "membership.updated": {
      const role = typeof p.role === "string" ? p.role : p.role === null ? "removed" : "member";
      return {
        icon: Users,
        summary: `${actor(p.actorId) ?? "?"} → ${role}${typeof p.channelId === "string" ? ` in ${channel(p.channelId)}` : ""}`,
        tone: "bg-zinc-800 text-zinc-300",
      };
    }
    case "grant.created":
      return {
        icon: Key,
        summary: `${String(p.capability ?? "?")} → ${actor(p.actorId) ?? "?"}${p.maxUses ? ` (${p.maxUses}x)` : ""}`,
        tone: "bg-emerald-500/15 text-emerald-300",
      };
    case "grant.revoked":
      return {
        icon: ShieldBan,
        summary:
          p.autoRevoked === true
            ? `Grant auto-revoked (${String(p.reason ?? "exhausted")})`
            : `Grant revoked${p.reason ? ` (${String(p.reason)})` : ""}`,
        tone: "bg-red-500/15 text-red-300",
      };
    case "permission_request.created":
      return {
        icon: ShieldQuestion,
        summary: `${actor(p.actorId) ?? "?"} requested ${String(p.action ?? "?")}`,
        tone: "bg-amber-500/15 text-amber-300",
      };
    case "permission_request.resolved": {
      const status = String(p.status ?? "?");
      return {
        icon: status === "approved" ? ShieldCheck : XCircle,
        summary: `Request ${status} by ${actor(p.resolverActorId) ?? "?"}`,
        tone: status === "approved" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300",
      };
    }
    case "artifact.registered":
      return {
        icon: Paperclip,
        summary: `${String(p.filename ?? "?")} uploaded by ${actor(p.createdByActorId) ?? "?"}`,
        tone: "bg-indigo-500/15 text-indigo-300",
      };
    case "artifact.deleted":
      return {
        icon: Trash2,
        summary: `Artifact deleted by ${actor(p.deletedByActorId) ?? "?"}`,
        tone: "bg-red-500/15 text-red-300",
      };
    case "memory.promoted":
      return {
        icon: Star,
        summary: `Memory promoted by ${actor(p.promotedByActorId) ?? "?"}`,
        tone: "bg-amber-500/15 text-amber-300",
      };
    case "cursor.updated":
      return {
        icon: ArrowRight,
        summary: `${actor(p.actorId) ?? "?"} caught up in ${channel(p.streamId) ?? "?"}`,
        tone: "bg-zinc-800/60 text-zinc-400",
      };
    case "client.registered":
      return {
        icon: Radio,
        summary: `Client registered by ${actor(p.actorId) ?? "?"}`,
        tone: "bg-zinc-800 text-zinc-300",
      };
    default:
      return {
        icon: ArrowRight,
        summary: row.eventType,
        tone: "bg-zinc-800/60 text-zinc-400",
      };
  }
}
