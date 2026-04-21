"use client";

import { GenuiPartView } from "@/components/genui/genui-part-view";

type MessagePart = { type: string; payload: Record<string, unknown> };

type Message = {
  id: string;
  streamSeq: number;
  actorId: string;
  createdAt: string;
  parts: MessagePart[];
};

type Actor = { actorId: string; displayName: string; actorType: string };

type ThreadRef = {
  id: string;
  createdAt: string;
};

type Props = {
  message: Message;
  actorsById: Record<string, Actor>;
  currentActorId: string | null;
  threads: ThreadRef[];
  activeThreadId: string | null;
  onCreateThread: (parentMessageId: string) => void;
  onOpenThread: (threadId: string) => void;
};

function senderLabel(message: Message, actorsById: Record<string, Actor>, currentActorId: string | null) {
  const actor = actorsById[message.actorId];
  if (!actor) {
    return { name: message.actorId.slice(0, 10), tag: "unknown", isAgent: false, isYou: false };
  }
  const isAgent = actor.actorType === "agent";
  const isYou = currentActorId !== null && actor.actorId === currentActorId;
  return {
    name: isYou ? `${actor.displayName} (you)` : actor.displayName,
    tag: actor.actorType,
    isAgent,
    isYou,
  };
}

function formatThreadLabel(thread: ThreadRef, index: number): string {
  const suffix = Number.isNaN(new Date(thread.createdAt).getTime())
    ? thread.id.slice(0, 6)
    : new Date(thread.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
  return `Thread ${index + 1} · ${suffix}`;
}

export function MessageCard({
  message,
  actorsById,
  currentActorId,
  threads,
  activeThreadId,
  onCreateThread,
  onOpenThread,
}: Props) {
  const sender = senderLabel(message, actorsById, currentActorId);
  const contentParts = message.parts.filter((part) => part.type !== "tool_call" && part.type !== "tool_result");
  const toolParts = message.parts.filter((part) => part.type === "tool_call" || part.type === "tool_result");

  const accent = sender.isAgent
    ? "border-emerald-500/40 bg-emerald-500/[0.04]"
    : sender.isYou
      ? "border-sky-500/40 bg-sky-500/[0.04]"
      : "border-zinc-800/80 bg-zinc-900/40";

  return (
    <div className={`mb-4 rounded-xl border ${accent} p-4 shadow-sm shadow-black/20`}>
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              sender.isAgent ? "bg-emerald-400" : sender.isYou ? "bg-sky-400" : "bg-zinc-500"
            }`}
          />
          <span className="font-medium text-zinc-200">{sender.name}</span>
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
            {sender.tag}
          </span>
          <span className="text-zinc-600">seq {message.streamSeq}</span>
        </div>
        <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
      </div>

      <div className="mt-3 space-y-2">
        {contentParts.map((part, index) => (
          <MessagePartView key={index} part={part} />
        ))}
        {toolParts.length > 0 ? (
          <details className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-300">
            <summary className="cursor-pointer list-none font-medium text-zinc-300">
              Tool activity ({toolParts.length})
            </summary>
            <div className="mt-2 space-y-2">
              {toolParts.map((part, index) => (
                <MessagePartView key={`tool-${index}`} part={part} />
              ))}
            </div>
          </details>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-800"
          type="button"
          onClick={() => onCreateThread(message.id)}
          data-testid="create-thread"
        >
          {threads.length > 0 ? "New thread" : "Create thread"}
        </button>
        {threads.map((thread, index) => {
          const active = thread.id === activeThreadId;
          return (
            <button
              key={thread.id}
              type="button"
              onClick={() => onOpenThread(thread.id)}
              data-testid="open-thread"
              className={`rounded-full px-3 py-1 text-[11px] font-medium transition ${
                active
                  ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/50"
                  : "bg-zinc-800/80 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              💬 {formatThreadLabel(thread, index)}
            </button>
          );
        })}
        {threads.length > 1 ? (
          <span className="text-[11px] text-zinc-500">{threads.length} threads</span>
        ) : null}
      </div>
    </div>
  );
}

function MessagePartView({ part }: { part: MessagePart }) {
  if (part.type === "text") {
    const text = String(part.payload.text ?? "");
    const kind = typeof part.payload.kind === "string" ? part.payload.kind : null;
    if (kind === "thinking") {
      return (
        <div className="rounded-lg border border-fuchsia-900/60 bg-fuchsia-950/30 px-3 py-2 text-xs text-fuchsia-100">
          <div className="mb-1 font-semibold">Thinking</div>
          <p className="whitespace-pre-wrap leading-relaxed text-fuchsia-100/90">{text}</p>
        </div>
      );
    }
    if (kind === "references") {
      return (
        <div className="rounded-lg border border-sky-900/60 bg-sky-950/30 px-3 py-2 text-xs text-sky-100">
          <div className="mb-1 font-semibold">References</div>
          <p className="whitespace-pre-wrap leading-relaxed text-sky-100/90">{text}</p>
        </div>
      );
    }
    return <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-100">{text}</p>;
  }

  if (part.type === "tool_call") {
    const toolName = String(part.payload.toolName ?? part.payload.name ?? "tool");
    return (
      <div className="rounded-lg border border-yellow-900/80 bg-yellow-950/40 px-3 py-2 text-xs text-yellow-200">
        <div className="font-semibold">▶ {toolName}</div>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px] text-yellow-100/80">
          {JSON.stringify(part.payload.args ?? part.payload.input ?? {}, null, 2)}
        </pre>
      </div>
    );
  }

  if (part.type === "tool_result") {
    const isError = Boolean(part.payload.isError ?? part.payload.error);
    const content = String(part.payload.content ?? part.payload.output ?? "").slice(0, 1200);
    const references = Array.isArray(part.payload.references)
      ? part.payload.references.filter((item) => typeof item === "string").map((item) => String(item))
      : [];
    return (
      <div
        className={`rounded-lg border px-3 py-2 text-xs ${
          isError
            ? "border-red-900/60 bg-red-950/40 text-red-200"
            : "border-zinc-800 bg-zinc-900/70 text-zinc-300"
        }`}
      >
        <div className={`font-semibold ${isError ? "text-red-300" : "text-zinc-300"}`}>
          {isError ? "✗" : "✓"} {String(part.payload.toolName ?? "result")}
        </div>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px]">{content}</pre>
        {references.length > 0 ? (
          <div className="mt-2 space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-zinc-400">References</div>
            {references.map((ref, index) => (
              <div key={`${ref}-${index}`} className="text-[11px] text-zinc-300">
                {ref}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (part.type === "approval_request") {
    return (
      <div className="rounded-lg border border-amber-700/60 bg-amber-900/30 px-3 py-2 text-xs text-amber-100">
        <div className="font-semibold">⚠ Approval requested</div>
        <div className="mt-1 text-amber-100/90">tool: {String(part.payload.toolName ?? "unknown")}</div>
        <div className="text-amber-100/60">id: {String(part.payload.requestId ?? "")}</div>
      </div>
    );
  }

  if (part.type === "approval_response") {
    const approved = Boolean(part.payload.approved);
    return (
      <div
        className={`rounded-lg border px-3 py-2 text-xs ${
          approved
            ? "border-emerald-700/60 bg-emerald-900/30 text-emerald-200"
            : "border-red-800/60 bg-red-900/30 text-red-200"
        }`}
      >
        {approved ? "✓ Approved" : "✗ Denied"}
        <span className="ml-2 text-zinc-400">id: {String(part.payload.requestId ?? "")}</span>
      </div>
    );
  }

  if (part.type === "ui") {
    return <GenuiPartView payload={part.payload} />;
  }

  if (part.type === "artifact") {
    const name = String(part.payload.name ?? "artifact");
    const url = typeof part.payload.url === "string" ? part.payload.url : null;
    return (
      <div className="rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300">
        <div className="flex items-center gap-2">
          <span>📎</span>
          {url ? (
            <a className="text-sky-300 underline underline-offset-2" href={url} target="_blank" rel="noreferrer">
              {name}
            </a>
          ) : (
            <span>{name}</span>
          )}
        </div>
        {typeof part.payload.mimeType === "string" ? (
          <div className="mt-1 text-zinc-500">{String(part.payload.mimeType)}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-400">
      <div className="font-semibold text-zinc-300">{part.type}</div>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px]">{JSON.stringify(part.payload, null, 2)}</pre>
    </div>
  );
}
