"use client";

import {
  MessageSquarePlus,
  MessageSquare,
  ChevronRight,
  Paperclip,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Play,
  Brain,
  BookOpen,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
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

  return (
    <div className="group flex gap-3 rounded-lg px-3 py-2.5 transition hover:bg-zinc-900/40">
      <Avatar
        name={sender.name}
        type={sender.tag}
        size="md"
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        {/* Header */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">{sender.name}</span>
          <Badge
            variant={sender.isAgent ? "emerald" : sender.tag === "app" ? "indigo" : "secondary"}
          >
            {sender.tag}
          </Badge>
          <span className="text-[11px] text-zinc-600">{formatTime(message.createdAt)}</span>
        </div>

        {/* Content */}
        <div className="mt-1 space-y-1.5">
          {contentParts.map((part, index) => (
            <MessagePartView key={index} part={part} />
          ))}
          {toolParts.length > 0 && (
            <details className="mt-1 rounded-lg border border-zinc-800/60 bg-zinc-900/30">
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs font-medium text-zinc-400">
                <Terminal className="h-3 w-3" />
                Tool activity ({toolParts.length})
              </summary>
              <div className="space-y-1.5 border-t border-zinc-800/40 p-3">
                {toolParts.map((part, index) => (
                  <MessagePartView key={`tool-${index}`} part={part} />
                ))}
              </div>
            </details>
          )}
        </div>

        {/* Thread actions */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px] text-zinc-500 opacity-0 transition group-hover:opacity-100"
            onClick={() => onCreateThread(message.id)}
            data-testid="create-thread"
          >
            <MessageSquarePlus className="mr-1 h-3 w-3" />
            {threads.length > 0 ? "New thread" : "Reply in thread"}
          </Button>
          {threads.map((thread, index) => {
            const active = thread.id === activeThreadId;
            return (
              <button
                key={thread.id}
                type="button"
                onClick={() => onOpenThread(thread.id)}
                data-testid="open-thread"
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition",
                  active
                    ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
                    : "bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
                )}
              >
                <MessageSquare className="h-3 w-3" />
                {formatThreadLabel(thread, index)}
                <ChevronRight className="h-3 w-3 opacity-50" />
              </button>
            );
          })}
        </div>
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
        <div className="flex items-start gap-2 rounded-lg border border-fuchsia-900/40 bg-fuchsia-950/20 px-3 py-2 text-xs">
          <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fuchsia-400" />
          <div>
            <p className="mb-0.5 font-semibold text-fuchsia-300">Thinking</p>
            <p className="whitespace-pre-wrap leading-relaxed text-fuchsia-100/80">{text}</p>
          </div>
        </div>
      );
    }
    if (kind === "references") {
      return (
        <div className="flex items-start gap-2 rounded-lg border border-sky-900/40 bg-sky-950/20 px-3 py-2 text-xs">
          <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-400" />
          <div>
            <p className="mb-0.5 font-semibold text-sky-300">References</p>
            <p className="whitespace-pre-wrap leading-relaxed text-sky-100/80">{text}</p>
          </div>
        </div>
      );
    }
    return <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">{text}</p>;
  }

  if (part.type === "mention") {
    const label = String(part.payload.label ?? "@mention");
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-300">
        @{label}
      </span>
    );
  }

  if (part.type === "command") {
    const command = String(part.payload.command ?? "command");
    const args = part.payload.args ?? {};
    return (
      <div className="rounded-lg border border-indigo-800/40 bg-indigo-950/20 px-3 py-2 text-xs">
        <p className="font-semibold text-indigo-300">/{command}</p>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px] text-indigo-200/70">
          {JSON.stringify(args, null, 2)}
        </pre>
      </div>
    );
  }

  if (part.type === "tool_call") {
    const toolName = String(part.payload.toolName ?? part.payload.name ?? "tool");
    return (
      <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 px-3 py-2 text-xs">
        <div className="flex items-center gap-1.5 font-semibold text-amber-300">
          <Play className="h-3 w-3" />
          {toolName}
        </div>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px] text-amber-200/70">
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
        className={cn(
          "rounded-lg border px-3 py-2 text-xs",
          isError
            ? "border-red-800/40 bg-red-950/20 text-red-200"
            : "border-zinc-800/40 bg-zinc-900/30 text-zinc-300",
        )}
      >
        <div className="flex items-center gap-1.5 font-semibold">
          {isError ? (
            <XCircle className="h-3 w-3 text-red-400" />
          ) : (
            <CheckCircle2 className="h-3 w-3 text-emerald-400" />
          )}
          {String(part.payload.toolName ?? "result")}
        </div>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px]">{content}</pre>
        {references.length > 0 && (
          <div className="mt-2 space-y-0.5 border-t border-zinc-800/40 pt-1.5">
            <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">References</p>
            {references.map((ref, index) => (
              <p key={`${ref}-${index}`} className="text-[11px] text-zinc-400">{ref}</p>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (part.type === "approval_request") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-amber-700/40 bg-amber-900/15 px-3 py-2 text-xs text-amber-200">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
        <div>
          <p className="font-semibold">Approval requested</p>
          <p className="mt-0.5 text-amber-200/70">tool: {String(part.payload.toolName ?? "unknown")}</p>
        </div>
      </div>
    );
  }

  if (part.type === "approval_response") {
    const approved = Boolean(part.payload.approved);
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
          approved
            ? "border-emerald-700/40 bg-emerald-900/15 text-emerald-200"
            : "border-red-800/40 bg-red-900/15 text-red-200",
        )}
      >
        {approved ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
        ) : (
          <XCircle className="h-3.5 w-3.5 text-red-400" />
        )}
        {approved ? "Approved" : "Denied"}
        <span className="ml-1 text-zinc-500">id: {String(part.payload.requestId ?? "")}</span>
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
      <div className="inline-flex items-center gap-2 rounded-lg border border-zinc-700/60 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-300">
        <Paperclip className="h-3.5 w-3.5 text-zinc-500" />
        {url ? (
          <a className="font-medium text-sky-300 underline underline-offset-2" href={url} target="_blank" rel="noreferrer">
            {name}
          </a>
        ) : (
          <span className="font-medium">{name}</span>
        )}
        {typeof part.payload.mimeType === "string" && (
          <Badge variant="secondary">{String(part.payload.mimeType)}</Badge>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800/40 bg-zinc-900/30 px-3 py-2 text-xs text-zinc-400">
      <p className="font-semibold text-zinc-300">{part.type}</p>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px]">{JSON.stringify(part.payload, null, 2)}</pre>
    </div>
  );
}
