"use client";

import { useEffect, useRef, useState } from "react";
import { X, Send, Paperclip, AtSign, Slash } from "lucide-react";
import { cn } from "@/lib/utils";
import { MessageCard } from "@/components/message-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
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

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter") return;
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    if (commandQuery === null || slashSuggestions.length === 0) return;
    event.preventDefault();
    selectCommand(slashSuggestions[0].name);
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

  const parentActor = parentMessage
    ? actorsById[parentMessage.actorId]
    : null;

  return (
    <aside
      className="flex w-[400px] flex-col border-l border-zinc-800/60 bg-zinc-950"
      aria-label="thread panel"
    >
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800/60 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-zinc-100">
            Thread {threadIndex + 1}
            <span className="ml-1 font-normal text-zinc-500">of {threadCount}</span>
          </p>
          <p className="mt-0.5 truncate text-[10px] text-zinc-600" title={threadId}>
            {threadId.slice(0, 12)}…
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          data-testid="close-thread"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      {/* Parent message preview */}
      {parentMessage && (
        <div className="border-b border-zinc-800/60 bg-zinc-900/20 px-4 py-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Replying to
          </p>
          <div className="flex gap-2.5 rounded-lg border border-zinc-800/40 bg-zinc-950/60 p-2.5">
            {parentActor && (
              <Avatar name={parentActor.displayName} type={parentActor.actorType} size="sm" className="mt-0.5" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-zinc-300">
                {parentActor?.displayName ?? parentMessage.actorId.slice(0, 10)}
              </p>
              <div className="mt-0.5 max-h-20 overflow-hidden text-xs leading-relaxed text-zinc-400">
                {parentMessage.parts.map((part, index) => {
                  if (part.type === "text") {
                    return (
                      <p key={index} className="whitespace-pre-wrap">
                        {String(part.payload.text ?? "")}
                      </p>
                    );
                  }
                  return (
                    <p key={index} className="italic text-zinc-600">
                      [{part.type}]
                    </p>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-2 py-3" data-testid="thread-messages">
        {messages.length === 0 ? (
          <p className="mt-8 text-center text-xs text-zinc-500">
            No replies yet. Start the conversation.
          </p>
        ) : (
          <div className="space-y-0.5">
            {messages.map((message) => (
              <MessageCard
                key={message.id}
                message={message}
                actorsById={actorsById}
                currentActorId={currentActorId}
                threads={[]}
                activeThreadId={null}
                onCreateThread={() => {}}
                onOpenThread={() => {}}
              />
            ))}
          </div>
        )}
      </div>

      {/* Composer */}
      <form className="border-t border-zinc-800/60 bg-zinc-950/90 p-3" onSubmit={sendMessage}>
        <div className="relative">
          <Textarea
            className="min-h-[64px] resize-none text-xs"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Reply in thread…"
            data-testid="thread-input"
          />
          {mentionQuery !== null && mentionSuggestions.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-40 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900/95 p-1 shadow-xl">
              {mentionSuggestions.map((actor) => (
                <button
                  key={actor.actorId}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition hover:bg-zinc-800"
                  onClick={() => selectMention(actor.displayName)}
                >
                  <AtSign className="h-3 w-3 text-sky-400" />
                  <span className="text-zinc-200">{actor.displayName}</span>
                  <Badge variant="secondary" className="ml-auto">{actor.actorType}</Badge>
                </button>
              ))}
            </div>
          )}
          {commandQuery !== null && slashSuggestions.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-40 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900/95 p-1 shadow-xl">
              {slashSuggestions.map((cmd) => (
                <button
                  key={`${cmd.ownerActorId}:${cmd.name}`}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition hover:bg-zinc-800"
                  onClick={() => selectCommand(cmd.name)}
                >
                  <Slash className="h-3 w-3 text-indigo-400" />
                  <span className="text-zinc-200">{cmd.name}</span>
                  <span className="ml-auto truncate text-[10px] text-zinc-500">
                    {cmd.description ?? cmd.ownerActorId.slice(0, 8)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-100">
            <Paperclip className="h-3 w-3" />
            Attach
            <input className="hidden" type="file" onChange={uploadAttachment} />
          </label>
          <div className="flex-1" />
          {pendingUpload.length > 0 && (
            <span className="text-[10px] text-zinc-500">
              {pendingUpload.length} file{pendingUpload.length > 1 ? "s" : ""}
            </span>
          )}
          <Button type="submit" size="sm" data-testid="thread-send">
            <Send className="mr-1 h-3 w-3" />
            Reply
          </Button>
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </form>
    </aside>
  );
}
