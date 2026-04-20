"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { MessageRecord, PermissionRequest } from "@/lib/message-layer-client";
import { MessageLayerClient } from "@/lib/message-layer-client";
import { ML_BASE_URL, DEV_PRINCIPAL, DEFAULT_CHANNEL_ID } from "@/lib/config";
import MessageBubble from "@/components/MessageBubble";
import ApprovalCard from "@/components/ApprovalCard";
import ModelSelector from "@/components/ModelSelector";

function getClient() {
  return new MessageLayerClient(ML_BASE_URL, DEV_PRINCIPAL);
}

export default function Home() {
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [approvals, setApprovals] = useState<PermissionRequest[]>([]);
  const [channelId, setChannelId] = useState(DEFAULT_CHANNEL_ID);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const afterSeqRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Health check
  useEffect(() => {
    getClient().health().then(setServerOk);
  }, []);

  // Poll messages + approvals when channel is set
  const pollMessages = useCallback(async () => {
    if (!channelId) return;
    try {
      const client = getClient();
      const [newMessages, newApprovals] = await Promise.all([
        client.listMessages(channelId, afterSeqRef.current, 50),
        client.listOpenPermissionRequests(),
      ]);
      if (newMessages.length > 0) {
        const maxSeq = Math.max(...newMessages.map((m) => m.streamSeq));
        afterSeqRef.current = maxSeq;
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          return [...prev, ...newMessages.filter((m) => !existingIds.has(m.id))];
        });
      }
      setApprovals(newApprovals);
    } catch {
      // silent poll errors
    }
  }, [channelId]);

  useEffect(() => {
    if (!channelId) return;
    afterSeqRef.current = 0;
    setMessages([]);
    void pollMessages();
    pollRef.current = setInterval(pollMessages, 1500);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [channelId, pollMessages]);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || !channelId) return;
    setInput("");
    setStatus("loading");
    setError(null);
    try {
      const client = getClient();
      await client.appendMessage(channelId, "channel", [{ type: "text", payload: { text } }], `human-${Date.now()}`);
      await pollMessages();
    } catch (err) {
      setError(String(err));
    } finally {
      setStatus("idle");
    }
  }

  async function handleApprove(requestId: string) {
    try {
      await getClient().resolvePermissionRequest(requestId, true);
      setApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDeny(requestId: string) {
    try {
      await getClient().resolvePermissionRequest(requestId, false, "denied by user");
      setApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 font-mono text-sm">
      {/* Sidebar */}
      <aside className="w-64 border-r border-zinc-800 flex flex-col p-4 gap-4">
        <div>
          <span className="text-xs text-zinc-500 uppercase tracking-widest">message-layer</span>
          <h1 className="text-lg font-bold text-emerald-400 mt-1">× pi agent</h1>
        </div>

        {/* Server status */}
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`w-2 h-2 rounded-full ${serverOk === null ? "bg-zinc-600" : serverOk ? "bg-emerald-500" : "bg-red-500"}`}
          />
          <span className="text-zinc-400">{serverOk === null ? "checking…" : serverOk ? "server online" : "server offline"}</span>
        </div>

        {/* Channel config */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-500">Channel ID</label>
          <input
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500"
            placeholder="paste channel id…"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value.trim())}
          />
        </div>

        {/* Model selector */}
        <ModelSelector baseUrl={ML_BASE_URL} principal={DEV_PRINCIPAL} />

        {/* Approval inbox */}
        {approvals.length > 0 && (
          <div className="flex flex-col gap-2 mt-2">
            <span className="text-xs text-yellow-400 uppercase tracking-widest">
              ⚠ {approvals.length} pending
            </span>
            {approvals.map((a) => (
              <ApprovalCard
                key={a.requestId}
                approval={a}
                onApprove={handleApprove}
                onDeny={handleDeny}
              />
            ))}
          </div>
        )}

        <div className="mt-auto text-xs text-zinc-600">
          <div>actor: {DEV_PRINCIPAL.actorId}</div>
          <div>org: {DEV_PRINCIPAL.orgId}</div>
        </div>
      </aside>

      {/* Main chat */}
      <main className="flex flex-col flex-1 overflow-hidden">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-3">
          {!channelId && (
            <div className="text-center text-zinc-600 mt-16">
              Enter a channel ID in the sidebar to start
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              isAgent={msg.actorId !== DEV_PRINCIPAL.actorId}
            />
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-6 mb-2 p-2 bg-red-950 border border-red-800 text-red-300 text-xs rounded">
            {error}
          </div>
        )}

        {/* Input */}
        <form onSubmit={sendMessage} className="p-4 border-t border-zinc-800 flex gap-2">
          <input
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-emerald-500 disabled:opacity-40"
            placeholder={channelId ? "Type a message…" : "Set channel ID first"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!channelId || status === "loading"}
          />
          <button
            type="submit"
            disabled={!channelId || !input.trim() || status === "loading"}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 rounded text-sm font-bold transition-colors"
          >
            {status === "loading" ? "…" : "Send"}
          </button>
        </form>
      </main>
    </div>
  );
}
