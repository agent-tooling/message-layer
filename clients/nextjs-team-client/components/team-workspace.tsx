"use client";

import { useEffect, useMemo, useState } from "react";
import { authClient } from "@/lib/auth-client";

type Channel = { id: string; name: string; visibility: string };
type Message = {
  id: string;
  streamSeq: number;
  actorId: string;
  createdAt: string;
  parts: Array<{ type: string; payload: Record<string, unknown> }>;
};
type Member = { actorId: string; displayName: string; actorType: string };
type Attachment = { id: string; name: string; mimeType: string; sizeBytes: number; url: string };
type AgentRow = { actorId: string; displayName: string; actorType: string; createdAt: string };

export function TeamWorkspace() {
  const { data: session } = authClient.useSession();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [threadsByChannel, setThreadsByChannel] = useState<Record<string, Array<{ id: string; parentMessageId: string }>>>({});
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [pendingUpload, setPendingUpload] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const activeThreads = threadsByChannel[activeChannelId] ?? [];

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, cache: "no-store" });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? `request failed: ${response.status}`);
    }
    return payload;
  }

  async function refreshChannelsAndMembers() {
    const [channelResult, memberResult] = await Promise.all([
      api<{ channels: Channel[] }>("/api/team/channels"),
      api<{ members: Member[] }>("/api/team/members"),
    ]);
    const agentResult = await api<{ agents: AgentRow[] }>("/api/team/agents");
    setChannels(channelResult.channels);
    setMembers(memberResult.members);
    setAgents(agentResult.agents);
    const hasActive = channelResult.channels.some((channel) => channel.id === activeChannelId);
    if ((!activeChannelId || !hasActive) && channelResult.channels[0]) {
      setActiveChannelId(channelResult.channels[0].id);
    }
  }

  async function refreshMessages(channelId: string) {
    const result = await api<{ messages: Message[] }>(`/api/team/channels/${channelId}/messages`);
    setMessages(result.messages);
  }

  async function refreshThreads(channelId: string) {
    const result = await api<{ threads: Array<{ id: string; parentMessageId: string }> }>(
      `/api/team/channels/${channelId}/threads`,
    );
    setThreadsByChannel((prev) => ({ ...prev, [channelId]: result.threads }));
  }

  useEffect(() => {
    if (!session) return;
    void api<{ ok: true; defaultChannelId: string }>("/api/team/bootstrap", { method: "POST" })
      .then((result) => setActiveChannelId(result.defaultChannelId))
      .catch((err) => setError((err as Error).message));
    void refreshChannelsAndMembers().catch((err) => setError((err as Error).message));
  }, [session]);

  useEffect(() => {
    if (!activeChannelId) return;
    void refreshMessages(activeChannelId).catch((err) => setError((err as Error).message));
    void refreshThreads(activeChannelId).catch((err) => setError((err as Error).message));
    const timer = setInterval(() => {
      void refreshMessages(activeChannelId);
      void refreshThreads(activeChannelId);
    }, 1800);
    return () => clearInterval(timer);
  }, [activeChannelId]);

  const groupedMessages = useMemo(
    () =>
      messages.map((message) => ({
        ...message,
        text: message.parts
          .filter((part) => part.type === "text")
          .map((part) => String(part.payload.text ?? ""))
          .join("\n"),
        artifacts: message.parts.filter((part) => part.type === "artifact"),
      })),
    [messages],
  );

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!activeChannelId) return;
    try {
      await api(`/api/team/channels/${activeChannelId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: input, attachments: pendingUpload }),
      });
      setInput("");
      setPendingUpload([]);
      await refreshMessages(activeChannelId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function uploadAttachment(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !activeChannelId) return;
    const form = new FormData();
    form.set("streamId", activeChannelId);
    form.set("streamType", "channel");
    form.set("file", file);
    try {
      const result = await api<{ id: string; filename: string; mimeType: string; sizeBytes: number; downloadPath: string }>(
        "/api/team/attachments",
        { method: "POST", body: form },
      );
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
    }
  }

  async function createInvite() {
    try {
      const result = await api<{ inviteUrl: string }>("/api/team/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail }),
      });
      setInviteLink(result.inviteUrl);
      setInviteEmail("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function createNewChannel() {
    const name = newChannelName.trim();
    if (!name) return;
    try {
      const result = await api<{ channelId: string }>("/api/team/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setNewChannelName("");
      await refreshChannelsAndMembers();
      setActiveChannelId(result.channelId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function createThreadFromMessage(parentMessageId: string) {
    if (!activeChannelId) return;
    try {
      await api(`/api/team/channels/${activeChannelId}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentMessageId }),
      });
      await refreshThreads(activeChannelId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <aside className="flex w-80 flex-col border-r border-zinc-800/80 bg-zinc-950/90 px-4 py-5">
        <div className="mb-5 border-b border-zinc-800/80 pb-4">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Workspace</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">Team Messaging</h2>
          <p className="mt-1 text-xs text-zinc-400">Single-org control plane on message-layer</p>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-400">Channels</h3>
        </div>
        <div className="mt-3 space-y-1.5">
          {channels.map((channel) => (
            <button
              key={channel.id}
              className={`block w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                channel.id === activeChannelId
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
                  : "border-zinc-800 bg-zinc-900/60 text-zinc-200 hover:border-zinc-700 hover:bg-zinc-900"
              }`}
              onClick={() => setActiveChannelId(channel.id)}
              type="button"
            >
              #{channel.name}
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-3 py-2 text-sm outline-none transition focus:border-emerald-500/70"
            placeholder="new channel"
            value={newChannelName}
            onChange={(event) => setNewChannelName(event.target.value)}
          />
          <button
            className="rounded-lg bg-zinc-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-900 transition hover:bg-white"
            onClick={createNewChannel}
            type="button"
          >
            Add
          </button>
        </div>

        <div className="mt-6 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-400">Members</h3>
          <ul className="mt-2 space-y-1.5 text-sm text-zinc-300">
            {members.map((member) => (
              <li key={member.actorId} className="flex items-center justify-between gap-2">
                <span className="truncate">{member.displayName}</span>
                <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                  {member.actorType}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-4 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-400">Invite teammate</p>
          <input
            className="mt-2 w-full rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-3 py-2 text-sm outline-none transition focus:border-emerald-500/70"
            placeholder="teammate@company.com"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
          />
          <button
            className="mt-2 w-full rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white"
            onClick={createInvite}
            type="button"
          >
            Generate invite link
          </button>
          {inviteLink ? <p className="mt-2 break-all text-xs text-emerald-400">{inviteLink}</p> : null}
        </div>

        <div className="mt-4 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3 text-xs text-zinc-400">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-300">Agent onboarding</p>
          <p className="mt-2">Discovery: <code>/.well-known/agent-configuration</code></p>
          <p className="mt-1">Auth base: <code>/api/auth</code></p>
          <p className="mt-2">Agents run externally and use Agent Auth to onboard.</p>
          {agents.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {agents.map((agent) => (
                <li key={agent.actorId} className="text-zinc-300">
                  {agent.displayName} ({agent.actorId.slice(0, 8)})
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2">No agents onboarded yet.</p>
          )}
        </div>

        <div className="mt-auto pt-4 text-xs text-zinc-500">
          Signed in as <span className="text-zinc-300">{session?.user?.email ?? "unknown"}</span>
        </div>
      </aside>

      <main className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-zinc-800/80 bg-zinc-950/70 px-6 py-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">Active channel</p>
            <p className="mt-1 text-base font-semibold text-zinc-100">
              #{channels.find((channel) => channel.id === activeChannelId)?.name ?? "Select a channel"}
            </p>
          </div>
          <button
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800"
            onClick={() => authClient.signOut()}
            type="button"
          >
            Sign out
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          {groupedMessages.map((message) => (
            <div key={message.id} className="mb-4 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4 shadow-sm shadow-black/20">
              <div className="flex items-center justify-between text-xs text-zinc-500">
                <span className="font-medium text-zinc-300">{message.actorId}</span>
                <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-zinc-100">{message.text || "(non-text message)"}</p>
              {message.artifacts.map((artifact, index) => (
                <a
                  key={`${message.id}-artifact-${index}`}
                  className="mt-2 block text-xs text-sky-300 underline underline-offset-2"
                  href={String(artifact.payload.url ?? "#")}
                  target="_blank"
                  rel="noreferrer"
                >
                  Attachment: {String(artifact.payload.name ?? "artifact")}
                </a>
              ))}
              <button
                className="mt-3 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-800"
                type="button"
                onClick={() => createThreadFromMessage(message.id)}
              >
                Create thread
              </button>
            </div>
          ))}
        </div>

        <div className="border-t border-zinc-800/80 bg-zinc-950/80 p-5">
          <form className="space-y-3" onSubmit={sendMessage}>
            <textarea
              className="h-28 w-full rounded-xl border border-zinc-700/80 bg-zinc-900/80 p-3 text-sm leading-relaxed outline-none transition focus:border-emerald-500/70"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Send a message..."
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex cursor-pointer items-center rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 transition hover:bg-zinc-800">
                Attach file
                <input className="hidden" type="file" onChange={uploadAttachment} />
              </label>
              <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500" type="submit">
                Send
              </button>
            </div>
            {pendingUpload.length > 0 ? (
              <div className="text-xs text-zinc-400">
                Pending attachments: {pendingUpload.map((file) => file.name).join(", ")}
              </div>
            ) : null}
            {activeThreads.length > 0 ? (
              <div className="text-xs text-zinc-400">
                Threads in channel: {activeThreads.map((thread) => thread.id.slice(0, 8)).join(", ")}
              </div>
            ) : null}
            {error ? <p className="text-xs text-red-400">{error}</p> : null}
          </form>
        </div>
      </main>
    </div>
  );
}
