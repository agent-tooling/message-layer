"use client";

import { useState } from "react";
import {
  ShieldAlert,
  ChevronDown,
  ChevronRight,
  Clock,
  Timer,
  CalendarDays,
  Infinity as InfinityIcon,
  Settings2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type PermissionRequest = {
  requestId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  context: Record<string, unknown>;
  createdAt: string;
};

type ActorMeta = { actorId: string; displayName: string; actorType: string };

export type ResolveApprovalOptions = {
  notes?: string;
  expiresAt?: string | null;
  maxUses?: number | null;
};

type Props = {
  approvals: PermissionRequest[];
  actorsById: Record<string, ActorMeta>;
  channelsById: Record<string, { name: string }>;
  onResolve: (requestId: string, approve: boolean, options: ResolveApprovalOptions) => Promise<void>;
};

const APPROVAL_MODES: Array<{
  id: string;
  label: string;
  icon: typeof Clock;
  resolve: () => ResolveApprovalOptions;
  help: string;
}> = [
  { id: "once", label: "Once", icon: Timer, resolve: () => ({ maxUses: 1 }), help: "One-time use" },
  {
    id: "1h",
    label: "1 hour",
    icon: Clock,
    resolve: () => ({ expiresAt: isoOffset(60 * 60 * 1000) }),
    help: "Expires in 1 hour",
  },
  {
    id: "1d",
    label: "1 day",
    icon: CalendarDays,
    resolve: () => ({ expiresAt: isoOffset(24 * 60 * 60 * 1000) }),
    help: "Expires in 24 hours",
  },
  { id: "forever", label: "Forever", icon: InfinityIcon, resolve: () => ({}), help: "No expiry" },
];

function isoOffset(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export function ApprovalInbox({ approvals, actorsById, channelsById, onResolve }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});
  const [customExpiresAt, setCustomExpiresAt] = useState<Record<string, string>>({});
  const [customMaxUses, setCustomMaxUses] = useState<Record<string, string>>({});
  const [denyReason, setDenyReason] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, string | null>>({});

  if (approvals.length === 0) {
    return null;
  }

  async function resolve(
    requestId: string,
    approve: boolean,
    options: ResolveApprovalOptions,
    mode: string,
  ) {
    setPending((prev) => ({ ...prev, [requestId]: mode }));
    try {
      await onResolve(requestId, approve, options);
    } finally {
      setPending((prev) => ({ ...prev, [requestId]: null }));
    }
  }

  return (
    <div className="border-b border-amber-500/10 bg-amber-500/[0.02] px-5 py-3">
      <div className="mb-2 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-400" />
        <p className="text-xs font-semibold text-amber-300">
          Agent approvals ({approvals.length})
        </p>
      </div>
      <div className="space-y-1.5">
        {approvals.map((request) => {
          const actor = actorsById[request.actorId];
          const isOpen = expanded[request.requestId] ?? false;
          const isPending = pending[request.requestId];
          const customShown = customOpen[request.requestId] ?? false;
          const channel =
            request.resourceType === "channel" && request.resourceId ? channelsById[request.resourceId] : undefined;

          return (
            <div
              key={request.requestId}
              className="rounded-lg border border-amber-500/15 bg-zinc-950/60"
            >
              <button
                type="button"
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-amber-500/[0.03]"
                onClick={() => setExpanded((prev) => ({ ...prev, [request.requestId]: !prev[request.requestId] }))}
              >
                <Avatar
                  name={actor?.displayName ?? request.actorId.slice(0, 8)}
                  type={actor?.actorType ?? "agent"}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-semibold text-zinc-100">
                      {actor?.displayName ?? request.actorId.slice(0, 10)}
                    </span>
                    <span className="text-zinc-500">wants</span>
                    <Badge variant="amber">{request.action}</Badge>
                    <span className="text-zinc-500">on</span>
                    <span className="text-zinc-300">
                      {request.resourceType}
                      {channel ? ` #${channel.name}` : request.resourceId ? ` ${request.resourceId.slice(0, 10)}…` : ""}
                    </span>
                  </div>
                  <RequestPreview context={request.context} />
                </div>
                {isOpen ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                )}
              </button>

              {isOpen && (
                <div className="border-t border-amber-500/10 bg-zinc-950/60 px-3 py-3">
                  <ContextDetails context={request.context} channelsById={channelsById} />

                  <div className="mt-3">
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      Approve with…
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {APPROVAL_MODES.map((mode) => {
                        const Icon = mode.icon;
                        return (
                          <Button
                            key={mode.id}
                            variant="outline"
                            size="sm"
                            disabled={Boolean(isPending)}
                            title={mode.help}
                            onClick={() => resolve(request.requestId, true, mode.resolve(), mode.id)}
                            className="gap-1"
                          >
                            <Icon className="h-3 w-3" />
                            {isPending === mode.id ? "…" : mode.label}
                          </Button>
                        );
                      })}
                      <Button
                        variant={customShown ? "secondary" : "ghost"}
                        size="sm"
                        onClick={() =>
                          setCustomOpen((prev) => ({ ...prev, [request.requestId]: !prev[request.requestId] }))
                        }
                        className="gap-1"
                      >
                        <Settings2 className="h-3 w-3" />
                        Custom
                      </Button>
                    </div>

                    {customShown && (
                      <div className="mt-2 rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                            <span className="font-medium">Max uses</span>
                            <Input
                              type="number"
                              min={1}
                              placeholder="e.g. 3"
                              value={customMaxUses[request.requestId] ?? ""}
                              onChange={(e) =>
                                setCustomMaxUses((prev) => ({
                                  ...prev,
                                  [request.requestId]: e.target.value,
                                }))
                              }
                              className="h-8 text-xs"
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                            <span className="font-medium">Expires at</span>
                            <Input
                              type="datetime-local"
                              value={customExpiresAt[request.requestId] ?? ""}
                              onChange={(e) =>
                                setCustomExpiresAt((prev) => ({
                                  ...prev,
                                  [request.requestId]: e.target.value,
                                }))
                              }
                              className="h-8 text-xs"
                            />
                          </label>
                        </div>
                        <div className="mt-3 flex justify-end">
                          <Button
                            size="sm"
                            disabled={Boolean(isPending)}
                            onClick={() => {
                              const max = customMaxUses[request.requestId];
                              const exp = customExpiresAt[request.requestId];
                              const options: ResolveApprovalOptions = {};
                              if (max && Number.isFinite(Number(max)) && Number(max) >= 1) {
                                options.maxUses = Number(max);
                              }
                              if (exp) {
                                options.expiresAt = new Date(exp).toISOString();
                              }
                              if (!options.maxUses && !options.expiresAt) return;
                              void resolve(request.requestId, true, options, "custom");
                            }}
                          >
                            Approve with custom terms
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-3 flex items-end gap-2 border-t border-zinc-800/40 pt-3">
                    <label className="min-w-0 flex-1 text-[11px] text-zinc-400">
                      <span className="mb-1 block font-medium">Deny reason</span>
                      <Input
                        type="text"
                        placeholder="e.g. blocked by policy"
                        value={denyReason[request.requestId] ?? ""}
                        onChange={(e) =>
                          setDenyReason((prev) => ({ ...prev, [request.requestId]: e.target.value }))
                        }
                        className="h-8 text-xs"
                      />
                    </label>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={Boolean(isPending)}
                      onClick={() =>
                        resolve(
                          request.requestId,
                          false,
                          { notes: denyReason[request.requestId] || "denied via UI" },
                          "deny",
                        )
                      }
                    >
                      <XCircle className="mr-1 h-3 w-3" />
                      {isPending === "deny" ? "…" : "Deny"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RequestPreview({ context }: { context: Record<string, unknown> }) {
  const preview = describePreview(context);
  if (!preview) return null;
  return <p className="mt-0.5 truncate text-[11px] text-zinc-500">{preview}</p>;
}

function describePreview(context: Record<string, unknown>): string | null {
  const kind = typeof context.kind === "string" ? (context.kind as string) : null;
  if (kind === "message.append") {
    const parts = Array.isArray(context.parts) ? context.parts : [];
    const firstText = parts.find((p) => (p as { type?: unknown })?.type === "text") as
      | { text?: string }
      | undefined;
    if (firstText?.text) return `"${firstText.text}"`;
    const names = parts
      .map((p) => (p as { type?: unknown })?.type)
      .filter((t): t is string => typeof t === "string");
    return names.length > 0 ? `parts: ${names.join(", ")}` : null;
  }
  if (kind === "channel.create") {
    const name = context.name as string | undefined;
    const vis = context.visibility as string | undefined;
    return name ? `create ${vis ?? "public"} channel "${name}"` : null;
  }
  return null;
}

function ContextDetails({
  context,
  channelsById,
}: {
  context: Record<string, unknown>;
  channelsById: Record<string, { name: string }>;
}) {
  const kind = typeof context.kind === "string" ? (context.kind as string) : "unknown";

  if (kind === "message.append") {
    const streamId = context.streamId as string | undefined;
    const parts = Array.isArray(context.parts) ? (context.parts as Array<Record<string, unknown>>) : [];
    return (
      <div className="space-y-2 text-xs text-zinc-300">
        <Kv label="Intent" value="message.append" />
        <Kv
          label="Stream"
          value={
            streamId
              ? `${channelsById[streamId]?.name ? `#${channelsById[streamId].name} ` : ""}${streamId}`
              : "—"
          }
        />
        <Kv label="Idempotency" value={String(context.idempotencyKey ?? "—")} />
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Parts ({parts.length})
          </p>
          <div className="space-y-1">
            {parts.map((part, i) => (
              <div key={i} className="rounded border border-zinc-800/40 bg-zinc-900/30 px-2 py-1.5 text-[11px]">
                <Badge variant="secondary" className="mr-2">
                  #{i} {String(part.type ?? "?")}
                </Badge>
                {typeof part.text === "string" ? (
                  <span className="text-zinc-200">"{part.text}"</span>
                ) : Array.isArray(part.keys) ? (
                  <span className="text-zinc-500">keys: {(part.keys as string[]).join(", ")}</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (kind === "channel.create") {
    return (
      <div className="space-y-1.5 text-xs text-zinc-300">
        <Kv label="Intent" value="channel.create" />
        <Kv label="Name" value={String(context.name ?? "—")} />
        <Kv label="Visibility" value={String(context.visibility ?? "—")} />
      </div>
    );
  }

  return (
    <pre className="overflow-x-auto rounded-lg bg-zinc-900/30 p-2 text-[11px] text-zinc-400">
      {JSON.stringify(context, null, 2)}
    </pre>
  );
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</span>
      <span className="break-all text-xs text-zinc-300">{value}</span>
    </div>
  );
}
