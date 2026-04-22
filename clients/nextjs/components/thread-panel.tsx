"use client";

import { useEffect, useRef, useState } from "react";
import { MessageCard } from "@/components/message-card";
import {
  applyCommandSelection,
  applyMentionSelection,
  extractActiveCommandQuery,
  extractActiveMentionQuery,
  parseComposerInput,
  type CommandSuggestion,
} from "@/lib/composer-parts";

type MessagePart = { type: string; payload: Record<string, unknown> };
type Message = {
  id: string;
  streamSeq: number;
  actorId: string;
  createdAt: string;
  parts: MessagePart[];
};
type Actor = { actorId: string; displayName: string; actorType: string };
type Attachment = { id: string; name: string; mimeType: string; sizeBytes: number; url: string };

type Props = {
  threadId: string;
  threadIndex: number;
  threadCount: number;
  parentMessage: Message | null;
  actorsById: Record<string, Actor>;
  commands: CommandSuggestion[];
  currentActorId: string | null;
  onClose: () => void;
};

export function ThreadPanel({
  threadId,
  threadIndex,
  threadCount,
  parentMessage,
  actorsById,
  commands,
  currentActorId,
  onClose,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pendingUpload, setPendingUpload] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const mentionQuery = extractActiveMentionQuery(input);
  const commandQuery = extractActiveCommandQuery(input);
  const mentionSuggestions = Object.values(actorsById)
    .filter((actor) => actor.actorId !== currentActorId)
    .filter((actor) =>
      mentionQuery === null || mentionQuery.trim().length === 0
        ? true
        : actor.displayName.toLowerCase().includes(mentionQuery.trim().toLowerCase()),
    )
    .slice(0, 6);
  const slashSuggestions = commands
    .filter((cmd) =>
      commandQuery === null || commandQuery.trim().length === 0
        ? true
        : cmd.name.toLowerCase().includes(commandQuery.trim().toLowerCase()),
    )
    .slice(0, 8);

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, cache: "no-store" });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? `request failed: ${response.status}`);
    }
    return payload;
  }

  async function refresh() {
    try {
      const result = await api<{ messages: Message[] }>(`/api/team/threads/${threadId}/messages`);
      setMessages(result.messages);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    setMessages([]);
    setError(null);
    setInput("");
    setPendingUpload([]);
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2200);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const parsed = parseComposerInput({
      text: input,
      actors: Object.values(actorsById).map((actor) => ({
        actorId: actor.actorId,
        displayName: actor.displayName,
        actorType: actor.actorType,
      })),
      commands,
    });
    if (parsed.parts.length === 0 && pendingUpload.length === 0) return;
    const parts: Array<{
      type: "text" | "artifact" | "mention" | "command";
      payload: Record<string, unknown>;
    }> = [...parsed.parts];
    for (const attachment of pendingUpload) {
      parts.push({
        type: "artifact",
        payload: {
          attachmentId: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          url: attachment.url,
        },
      });
    }
    try {
      await api(`/api/team/threads/${threadId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      });
      setInput("");
      setPendingUpload([]);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function selectMention(displayName: string) {
    setInput((current) => applyMentionSelection(current, displayName));
  }

  function selectCommand(name: string) {
    setInput((current) => applyCommandSelection(current, name));
  }

  async function uploadAttachment(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.set("streamId", threadId);
    form.set("streamType", "thread");
    form.set("file", file);
    try {
      const result = await api<{
        id: string;
        filename: string;
        mimeType: string;
        sizeBytes: number;
        downloadPath: string;
      }>("/api/team/attachments", { method: "POST", body: form });
      setPendingUpload((prev) => [
        ...prev,
        {
          id: result.id,
          name: result.filename,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
          url: result.downloadPath,
        },
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      event.target.value = "";
    }
  }

  return (
    <aside
      className="flex w-[420px] flex-col border-l border-zinc-800/80 bg-zinc-950/95"
      aria-label="thread panel"
    >
      <header className="flex items-start justify-between gap-3 border-b border-zinc-800/80 px-5 py-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
            Thread {threadIndex + 1} of {threadCount}
          </p>
          <p className="mt-1 truncate text-xs text-zinc-500" title={threadId}>
            id: {threadId.slice(0, 12)}…
          </p>
        </div>
        <button
          type="button"
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-800"
          onClick={onClose}
          data-testid="close-thread"
        >
          Close
        </button>
      </header>

      {parentMessage ? (
        <div className="border-b border-zinc-800/80 bg-zinc-900/40 px-5 py-4 text-xs text-zinc-400">
          <p className="mb-2 font-semibold uppercase tracking-[0.14em] text-zinc-500">Replying to</p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/80 p-3">
            <div className="mb-1 text-[11px] text-zinc-500">
              {actorsById[parentMessage.actorId]?.displayName ?? parentMessage.actorId.slice(0, 10)}
              <span className="ml-2 text-zinc-600">
                {new Date(parentMessage.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <div className="max-h-32 overflow-hidden text-sm leading-relaxed text-zinc-200">
              {parentMessage.parts.map((part, index) => {
                if (part.type === "text") {
                  return (
                    <p key={index} className="whitespace-pre-wrap">
                      {String(part.payload.text ?? "")}
                    </p>
                  );
                }
                return (
                  <p key={index} className="italic text-zinc-500">
                    [{part.type}]
                  </p>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4" data-testid="thread-messages">
        {messages.length === 0 ? (
          <p className="mt-6 text-center text-xs text-zinc-500">
            No replies yet. Start the conversation.
          </p>
        ) : (
          messages.map((message) => (
            <MessageCard
              key={message.id}
              message={message}
              actorsById={actorsById}
              currentActorId={currentActorId}
              threads={[]}
              activeThreadId={null}
              onCreateThread={() => {
                // nested thread creation is intentionally disabled in v1
              }}
              onOpenThread={() => {
                // no-op inside thread view
              }}
            />
          ))
        )}
      </div>

      <form className="space-y-3 border-t border-zinc-800/80 bg-zinc-950/80 p-4" onSubmit={sendMessage}>
        <div className="relative">
          <textarea
            className="h-24 w-full rounded-xl border border-zinc-700/80 bg-zinc-900/80 p-3 text-sm leading-relaxed outline-none transition focus:border-emerald-500/70"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Reply in thread... (@mention, /command)"
            data-testid="thread-input"
          />
          {mentionQuery !== null && mentionSuggestions.length > 0 ? (
            <div className="absolute left-2 right-2 top-2 z-10 max-h-40 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900/95 p-1 shadow-xl">
              {mentionSuggestions.map((actor) => (
                <button
                  key={actor.actorId}
                  type="button"
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-zinc-200 transition hover:bg-zinc-800"
                  onClick={() => selectMention(actor.displayName)}
                >
                  <span>@{actor.displayName}</span>
                  <span className="text-zinc-500">{actor.actorType}</span>
                </button>
              ))}
            </div>
          ) : null}
          {commandQuery !== null && slashSuggestions.length > 0 ? (
            <div className="absolute left-2 right-2 top-2 z-10 max-h-40 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900/95 p-1 shadow-xl">
              {slashSuggestions.map((cmd) => (
                <button
                  key={`${cmd.ownerActorId}:${cmd.name}`}
                  type="button"
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-zinc-200 transition hover:bg-zinc-800"
                  onClick={() => selectCommand(cmd.name)}
                >
                  <span>/{cmd.name}</span>
                  <span className="truncate pl-2 text-zinc-500">
                    {cmd.description ?? cmd.ownerActorId.slice(0, 8)}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 transition hover:bg-zinc-800">
            Attach file
            <input className="hidden" type="file" onChange={uploadAttachment} />
          </label>
          <button
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
            type="submit"
            data-testid="thread-send"
          >
            Send reply
          </button>
          <span className="text-xs text-zinc-500">Tip: @name and /poem</span>
        </div>
        {pendingUpload.length > 0 ? (
          <div className="text-xs text-zinc-400">
            Pending attachments: {pendingUpload.map((file) => file.name).join(", ")}
          </div>
        ) : null}
        {error ? <p className="text-xs text-red-400">{error}</p> : null}
      </form>
    </aside>
  );
}
