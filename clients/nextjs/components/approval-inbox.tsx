"use client";

import { useState } from "react";

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

const APPROVAL_MODES: Array<{ id: string; label: string; resolve: () => ResolveApprovalOptions; help: string }> = [
  { id: "once", label: "Once", resolve: () => ({ maxUses: 1 }), help: "Agent may perform exactly this action one time." },
  {
    id: "1h",
    label: "1 hour",
    resolve: () => ({ expiresAt: isoOffset(60 * 60 * 1000) }),
    help: "Grant expires one hour from now.",
  },
  {
    id: "1d",
    label: "1 day",
    resolve: () => ({ expiresAt: isoOffset(24 * 60 * 60 * 1000) }),
    help: "Grant expires 24 hours from now.",
  },
  { id: "forever", label: "Forever", resolve: () => ({}), help: "No expiry, unlimited uses. Revoke manually later." },
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
    <div className="border-b border-amber-500/10 bg-amber-500/[0.03] px-6 py-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-300">
          Agent approval requests ({approvals.length})
        </p>
        <p className="text-[11px] text-zinc-500">
          Read the intent below before deciding. Once-only approvals burn after a single use.
        </p>
      </div>
      <ul className="space-y-2">
        {approvals.map((request) => {
          const actor = actorsById[request.actorId];
          const isOpen = expanded[request.requestId] ?? false;
          const isPending = pending[request.requestId];
          const customShown = customOpen[request.requestId] ?? false;
          const channel =
            request.resourceType === "channel" && request.resourceId ? channelsById[request.resourceId] : undefined;

          return (
            <li
              key={request.requestId}
              className="overflow-hidden rounded-xl border border-amber-500/20 bg-zinc-950/60"
            >
              <button
                type="button"
                className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-amber-500/[0.05]"
                onClick={() => setExpanded((prev) => ({ ...prev, [request.requestId]: !prev[request.requestId] }))}
              >
                <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-xs font-semibold text-amber-200">
                  {actor?.actorType === "agent" ? "AI" : actor?.actorType === "app" ? "APP" : "U"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold text-zinc-100">
                      {actor?.displayName ?? request.actorId.slice(0, 10)}
                    </span>
                    <span className="text-zinc-500">wants</span>
                    <code className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-200">
                      {request.action}
                    </code>
                    <span className="text-zinc-500">on</span>
                    <span className="text-xs text-zinc-300">
                      {request.resourceType}
                      {channel ? ` #${channel.name}` : request.resourceId ? ` ${request.resourceId.slice(0, 10)}…` : ""}
                    </span>
                  </div>
                  <RequestPreview context={request.context} />
                </div>
                <span className="mt-1 text-xs text-zinc-500">{isOpen ? "▲" : "▼"}</span>
              </button>

              {isOpen ? (
                <div className="border-t border-amber-500/10 bg-zinc-950/80 px-4 py-3">
                  <ContextDetails context={request.context} channelsById={channelsById} />

                  <div className="mt-4 space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                      Approve with…
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {APPROVAL_MODES.map((mode) => (
                        <button
                          key={mode.id}
                          type="button"
                          disabled={Boolean(isPending)}
                          title={mode.help}
                          onClick={() => resolve(request.requestId, true, mode.resolve(), mode.id)}
                          className={modeButton(isPending === mode.id)}
                        >
                          {isPending === mode.id ? "…" : mode.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          setCustomOpen((prev) => ({ ...prev, [request.requestId]: !prev[request.requestId] }))
                        }
                        className={modeButton(false, customShown)}
                      >
                        Custom…
                      </button>
                    </div>

                    {customShown ? (
                      <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                            <span>Max uses (optional)</span>
                            <input
                              type="number"
                              min={1}
                              placeholder="e.g. 3"
                              value={customMaxUses[request.requestId] ?? ""}
                              onChange={(event) =>
                                setCustomMaxUses((prev) => ({
                                  ...prev,
                                  [request.requestId]: event.target.value,
                                }))
                              }
                              className={inputCls}
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                            <span>Expires at (optional)</span>
                            <input
                              type="datetime-local"
                              value={customExpiresAt[request.requestId] ?? ""}
                              onChange={(event) =>
                                setCustomExpiresAt((prev) => ({
                                  ...prev,
                                  [request.requestId]: event.target.value,
                                }))
                              }
                              className={inputCls}
                            />
                          </label>
                        </div>
                        <div className="mt-3 flex justify-end">
                          <button
                            type="button"
                            disabled={Boolean(isPending)}
                            onClick={() => {
                              const max = customMaxUses[request.requestId];
                              const exp = customExpiresAt[request.requestId];
                              const options: ResolveApprovalOptions = {};
                              if (max && Number.isFinite(Number(max)) && Number(max) >= 1) {
                                options.maxUses = Number(max);
                              }
                              if (exp) {
                                // <datetime-local> returns wall-clock time without TZ; convert to ISO.
                                options.expiresAt = new Date(exp).toISOString();
                              }
                              if (!options.maxUses && !options.expiresAt) return;
                              void resolve(request.requestId, true, options, "custom");
                            }}
                            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                          >
                            Approve with custom terms
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-4 flex items-end gap-2 border-t border-zinc-800/80 pt-3">
                    <label className="min-w-0 flex-1 text-[11px] text-zinc-400">
                      <span className="block">Deny reason (optional)</span>
                      <input
                        type="text"
                        placeholder="e.g. blocked by policy"
                        value={denyReason[request.requestId] ?? ""}
                        onChange={(event) =>
                          setDenyReason((prev) => ({ ...prev, [request.requestId]: event.target.value }))
                        }
                        className={inputCls}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={Boolean(isPending)}
                      onClick={() =>
                        resolve(
                          request.requestId,
                          false,
                          { notes: denyReason[request.requestId] || "denied via UI" },
                          "deny",
                        )
                      }
                      className="rounded-md border border-red-700/80 bg-red-700/20 px-3 py-1.5 text-xs font-semibold text-red-100 transition hover:bg-red-700/40 disabled:opacity-50"
                    >
                      {isPending === "deny" ? "…" : "Deny"}
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RequestPreview({ context }: { context: Record<string, unknown> }) {
  const preview = describePreview(context);
  if (!preview) return null;
  return <p className="mt-1 truncate text-[11px] text-zinc-400">{preview}</p>;
}

function describePreview(context: Record<string, unknown>): string | null {
  const kind = typeof context.kind === "string" ? (context.kind as string) : null;
  if (kind === "message.append") {
    const parts = Array.isArray(context.parts) ? context.parts : [];
    const firstText = parts.find((p) => (p as { type?: unknown })?.type === "text") as
      | { text?: string }
      | undefined;
    if (firstText?.text) return `“${firstText.text}”`;
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
      <div className="space-y-2 text-[12px] text-zinc-300">
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
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Parts ({parts.length})
          </p>
          <ul className="space-y-1">
            {parts.map((part, i) => (
              <li key={i} className="rounded border border-zinc-800 bg-zinc-900/40 p-2 text-[11px]">
                <span className="mr-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">
                  #{i} {String(part.type ?? "?")}
                </span>
                {typeof part.text === "string" ? (
                  <span className="whitespace-pre-wrap text-zinc-200">“{part.text}”</span>
                ) : Array.isArray(part.keys) ? (
                  <span className="text-zinc-400">keys: {(part.keys as string[]).join(", ")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (kind === "channel.create") {
    return (
      <div className="space-y-2 text-[12px] text-zinc-300">
        <Kv label="Intent" value="channel.create" />
        <Kv label="Name" value={String(context.name ?? "—")} />
        <Kv label="Visibility" value={String(context.visibility ?? "—")} />
      </div>
    );
  }

  // Fallback — render the raw JSON so nothing is silently hidden.
  return (
    <pre className="overflow-x-auto rounded bg-zinc-900/80 p-2 text-[11px] text-zinc-300">
      {JSON.stringify(context, null, 2)}
    </pre>
  );
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{label}</span>
      <span className="break-all text-[12px] text-zinc-200">{value}</span>
    </div>
  );
}

const inputCls =
  "rounded border border-zinc-700 bg-zinc-900/80 px-2 py-1 text-[12px] text-zinc-100 outline-none transition focus:border-emerald-500/60";

function modeButton(isPending: boolean, isToggled = false): string {
  if (isPending) {
    return "rounded-md bg-emerald-600/80 px-3 py-1.5 text-xs font-semibold text-white opacity-70";
  }
  if (isToggled) {
    return "rounded-md border border-emerald-600/80 bg-emerald-600/20 px-3 py-1.5 text-xs font-semibold text-emerald-200";
  }
  return "rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-zinc-200 transition hover:border-emerald-600/70 hover:text-emerald-200";
}
