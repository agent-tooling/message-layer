"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { authClient } from "@/lib/auth-client";
import {
  ApprovalInbox,
  type PermissionRequest as ApprovalPermissionRequest,
  type ResolveApprovalOptions,
} from "@/components/approval-inbox";
import { MessageCard } from "@/components/message-card";
import { ThreadPanel } from "@/components/thread-panel";

type Channel = { id: string; name: string; visibility: string };
type Message = {
  id: string;
  streamSeq: number;
  actorId: string;
  createdAt: string;
  parts: Array<{ type: string; payload: Record<string, unknown> }>;
};
type Member = {
  actorId: string;
  displayName: string;
  actorType: string;
  role: string;
  appRole: "owner" | "admin" | "member" | null;
  effectiveCapabilities: string[];
};
type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
};
type ActorRow = {
  actorId: string;
  displayName: string;
  actorType: string;
  createdAt: string;
};
type Thread = { id: string; parentMessageId: string; createdAt: string };
type PermissionRequest = ApprovalPermissionRequest;
type WebhookSubscription = {
  id: string;
  endpoint: string;
  eventTypes: string[];
  streamId: string | null;
  enabled: boolean;
  createdAt: string;
};

export function TeamWorkspace() {
  const { data: session } = authClient.useSession();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [actors, setActors] = useState<ActorRow[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [newChannelName, setNewChannelName] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [threadsByChannel, setThreadsByChannel] = useState<
    Record<string, Thread[]>
  >({});
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<PermissionRequest[]>([]);
  const [canResolveApprovals, setCanResolveApprovals] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<Attachment[]>([]);
  const [currentActorId, setCurrentActorId] = useState<string | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookSubscription[]>([]);
  const [webhooksAvailable, setWebhooksAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const activeThreads = threadsByChannel[activeChannelId] ?? [];

  const threadsByParentMessage = useMemo(() => {
    const map: Record<string, Thread[]> = {};
    for (const thread of activeThreads) {
      const list = map[thread.parentMessageId] ?? [];
      list.push(thread);
      map[thread.parentMessageId] = list;
    }
    // Keep a stable chronological ordering so "Thread 1" stays "Thread 1".
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (aTime !== bTime) return aTime - bTime;
        return a.id.localeCompare(b.id);
      });
    }
    return map;
  }, [activeThreads]);

  const activeThread = useMemo(() => {
    if (!activeThreadId) return null;
    return activeThreads.find((thread) => thread.id === activeThreadId) ?? null;
  }, [activeThreadId, activeThreads]);

  const activeThreadParentMessage = useMemo(() => {
    if (!activeThread) return null;
    return (
      messages.find((message) => message.id === activeThread.parentMessageId) ??
      null
    );
  }, [activeThread, messages]);

  const activeThreadSiblings = activeThread
    ? (threadsByParentMessage[activeThread.parentMessageId] ?? [])
    : [];
  const activeThreadIndex = activeThread
    ? activeThreadSiblings.findIndex((thread) => thread.id === activeThread.id)
    : -1;

  const actorsById = useMemo(() => {
    const map: Record<string, ActorRow> = {};
    for (const actor of actors) {
      map[actor.actorId] = actor;
    }
    return map;
  }, [actors]);

  const agents = useMemo(
    () => actors.filter((actor) => actor.actorType === "agent"),
    [actors],
  );
  const humanMembers = useMemo(
    () => members.filter((member) => member.actorType === "human"),
    [members],
  );

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, cache: "no-store" });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? `request failed: ${response.status}`);
    }
    return payload;
  }

  async function refreshDirectory() {
    const [channelResult, memberResult, actorResult] = await Promise.all([
      api<{ channels: Channel[] }>("/api/team/channels"),
      api<{ members: Member[] }>("/api/team/members"),
      api<{ actors: ActorRow[] }>("/api/team/actors"),
    ]);
    setChannels(channelResult.channels);
    setMembers(memberResult.members);
    setActors(actorResult.actors);
    const hasActive = channelResult.channels.some(
      (channel) => channel.id === activeChannelId,
    );
    if ((!activeChannelId || !hasActive) && channelResult.channels[0]) {
      setActiveChannelId(channelResult.channels[0].id);
    }
  }

  async function refreshApprovals() {
    const result = await api<{
      requests: PermissionRequest[];
      canResolve?: boolean;
    }>("/api/team/permission-requests");
    setApprovals(result.requests);
    setCanResolveApprovals(result.canResolve === true);
  }

  async function refreshMessages(channelId: string) {
    const result = await api<{ messages: Message[] }>(
      `/api/team/channels/${channelId}/messages`,
    );
    setMessages(result.messages);
  }

  async function refreshWebhooks() {
    const result = await api<{
      subscriptions: WebhookSubscription[];
      available?: boolean;
    }>("/api/team/webhooks");
    setWebhooks(result.subscriptions);
    setWebhooksAvailable(result.available !== false);
  }

  async function refreshThreads(channelId: string) {
    const result = await api<{ threads: Thread[] }>(
      `/api/team/channels/${channelId}/threads`,
    );
    setThreadsByChannel((prev) => ({ ...prev, [channelId]: result.threads }));
  }

  useEffect(() => {
    if (!session) return;
    void api<{ ok: true; defaultChannelId: string; actorId: string }>(
      "/api/team/bootstrap",
      { method: "POST" },
    )
      .then((result) => {
        setCurrentActorId(result.actorId);
        if (result.defaultChannelId) {
          setActiveChannelId((current) => current || result.defaultChannelId);
        }
      })
      .catch((err) => setError((err as Error).message));
    void refreshDirectory().catch((err) => setError((err as Error).message));
    void refreshWebhooks().catch(() => {
      // optional when plugin is not enabled
    });
    void refreshApprovals().catch(() => {
      // approvals are optional; silent fail
    });
  }, [session]);

  useEffect(() => {
    if (!activeChannelId) return;
    // Close any open thread when switching channels so the right panel
    // never shows a thread from a channel the user just left.
    setActiveThreadId(null);
    void refreshMessages(activeChannelId).catch((err) =>
      setError((err as Error).message),
    );
    void refreshThreads(activeChannelId).catch((err) =>
      setError((err as Error).message),
    );
    const timer = setInterval(() => {
      void refreshMessages(activeChannelId).catch(() => {});
      void refreshThreads(activeChannelId).catch(() => {});
      void refreshApprovals().catch(() => {});
      void refreshDirectory().catch(() => {});
      void refreshWebhooks().catch(() => {});
    }, 2200);
    return () => clearInterval(timer);
  }, [activeChannelId]);

  // If the open thread vanishes from the active channel (e.g. channel
  // switched, thread deleted server-side) clear the selection so stale
  // thread ids never leak into the right panel.
  useEffect(() => {
    if (!activeThreadId) return;
    const stillPresent = activeThreads.some(
      (thread) => thread.id === activeThreadId,
    );
    if (!stillPresent) setActiveThreadId(null);
  }, [activeThreadId, activeThreads]);

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!activeChannelId) return;
    const text = input.trim();
    if (!text && pendingUpload.length === 0) return;
    try {
      await api(`/api/team/channels/${activeChannelId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, attachments: pendingUpload }),
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

  async function createInvite() {
    try {
      const result = await api<{ inviteUrl: string }>("/api/team/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      setInviteLink(result.inviteUrl);
      setInviteEmail("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function updateMemberRole(actorId: string, role: "admin" | "member") {
    try {
      await api(`/api/team/members/${actorId}/role`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      await refreshDirectory();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function createNewChannel() {
    const name = newChannelName.trim();
    if (!name) return;
    try {
      const response = await fetch("/api/team/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        channelId?: string;
        permissionRequestId?: string;
        error?: string;
      };
      if (!response.ok) {
        if (payload.permissionRequestId) {
          throw new Error(
            `Channel request submitted for admin approval (${payload.permissionRequestId}).`,
          );
        }
        throw new Error(payload.error ?? `request failed: ${response.status}`);
      }
      if (!payload.channelId) {
        throw new Error("channel creation did not return a channel id");
      }
      setNewChannelName("");
      await refreshDirectory();
      setActiveChannelId(payload.channelId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resolveApproval(
    requestId: string,
    approve: boolean,
    options: ResolveApprovalOptions,
  ) {
    try {
      await api(`/api/team/permission-requests/${requestId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          approve,
          notes:
            options.notes ??
            (approve ? "approved via inbox" : "denied via inbox"),
          expiresAt: options.expiresAt ?? null,
          maxUses: options.maxUses ?? null,
        }),
      });
      setApprovals((prev) =>
        prev.filter((request) => request.requestId !== requestId),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const channelsById = useMemo(() => {
    const map: Record<string, { name: string }> = {};
    for (const channel of channels) {
      map[channel.id] = { name: channel.name };
    }
    return map;
  }, [channels]);

  async function createThreadFromMessage(parentMessageId: string) {
    if (!activeChannelId) return;
    try {
      const result = await api<{ threadId: string }>(
        `/api/team/channels/${activeChannelId}/threads`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentMessageId }),
        },
      );
      await refreshThreads(activeChannelId);
      // Auto-open the freshly created thread so the user lands directly
      // in the composer — this is the "new thread" affordance.
      setActiveThreadId(result.threadId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function openThread(threadId: string) {
    setActiveThreadId(threadId);
  }

  function closeThread() {
    setActiveThreadId(null);
  }

  function copyInviteLink() {
    if (!inviteLink) return;
    void navigator.clipboard?.writeText(inviteLink).catch(() => {});
  }

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <aside className="flex w-80 flex-col overflow-y-auto border-r border-zinc-800/80 bg-zinc-950/90 px-4 py-5">
        <div className="mb-5 border-b border-zinc-800/80 pb-4">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">
            Workspace
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">
            Team Messaging
          </h2>
          <p className="mt-1 text-xs text-zinc-400">
            Team + agents on message-layer
          </p>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-400">
            Channels
          </h3>
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
          <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-400">
            People
          </h3>
          <ul className="mt-2 space-y-1.5 text-sm text-zinc-300">
            {humanMembers.map((member) => (
              <li
                key={member.actorId}
                className="flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <span className="block truncate">{member.displayName}</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                      {member.actorType}
                    </span>
                    {member.appRole ? (
                      <span className="rounded bg-blue-950 px-2 py-0.5 text-[10px] uppercase tracking-wide text-blue-300">
                        role:{member.appRole}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-[10px] text-zinc-500">
                    grants: {member.effectiveCapabilities.join(", ") || "none"}
                  </p>
                </div>
                {member.appRole !== "owner" ? (
                  <select
                    className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[10px] uppercase text-zinc-300"
                    value={member.appRole ?? "member"}
                    onChange={(event) =>
                      void updateMemberRole(
                        member.actorId,
                        event.target.value === "admin" ? "admin" : "member",
                      )
                    }
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                ) : null}
              </li>
            ))}
            {humanMembers.length === 0 ? (
              <li className="text-xs text-zinc-500">No members yet.</li>
            ) : null}
          </ul>
        </div>

        <div className="mt-4 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-400">
            Invite teammate
          </p>
          <input
            className="mt-2 w-full rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-3 py-2 text-sm outline-none transition focus:border-emerald-500/70"
            placeholder="teammate@company.com"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
          />
          <select
            className="mt-2 w-full rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-3 py-2 text-sm outline-none transition focus:border-emerald-500/70"
            value={inviteRole}
            onChange={(event) =>
              setInviteRole(event.target.value === "admin" ? "admin" : "member")
            }
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <button
            className="mt-2 w-full rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white"
            onClick={createInvite}
            type="button"
          >
            Generate invite link
          </button>
          {inviteLink ? (
            <div className="mt-2 space-y-1">
              <p className="break-all rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-1.5 text-[11px] text-emerald-300">
                {inviteLink}
              </p>
              <button
                type="button"
                onClick={copyInviteLink}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-zinc-800"
              >
                Copy link
              </button>
            </div>
          ) : null}
        </div>

        <div className="mt-4 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3 text-xs text-zinc-400">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-300">
            Agents
          </p>
          {agents.length > 0 ? (
            <ul className="mt-2 space-y-1 text-zinc-300">
              {agents.map((agent) => (
                <li
                  key={agent.actorId}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="truncate">{agent.displayName}</span>
                  <span className="text-zinc-500">
                    {agent.actorId.slice(0, 8)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2">No agents onboarded yet.</p>
          )}
          <div className="mt-3 space-y-1 border-t border-zinc-800/60 pt-3 text-[11px] text-zinc-500">
            <p>
              Discovery: <code>/.well-known/agent-configuration</code>
            </p>
            <p>
              Auth base: <code>/api/auth</code>
            </p>
            <p>Agents run externally via Agent Auth.</p>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3 text-xs text-zinc-400">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-300">
            Webhooks
          </p>
          {!webhooksAvailable ? (
            <p className="mt-2">Webhook plugin is not enabled.</p>
          ) : webhooks.length === 0 ? (
            <p className="mt-2">No webhook subscriptions yet.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {webhooks.map((hook) => (
                <li
                  key={hook.id}
                  className="rounded-md border border-zinc-800 bg-zinc-900/80 px-2 py-2"
                >
                  <p className="truncate text-zinc-300">{hook.endpoint}</p>
                  <p className="mt-1 text-[11px] text-zinc-500">
                    {hook.eventTypes.join(", ")}
                    {hook.streamId
                      ? ` · stream ${hook.streamId.slice(0, 8)}`
                      : " · org-wide"}
                  </p>
                  {!hook.enabled ? (
                    <p className="mt-1 text-[11px] text-amber-300">disabled</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-auto pt-4 text-xs text-zinc-500">
          Signed in as{" "}
          <span className="text-zinc-300">
            {session?.user?.email ?? "unknown"}
          </span>
        </div>
      </aside>

      <main className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-zinc-800/80 bg-zinc-950/70 px-6 py-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">
              Active channel
            </p>
            <p className="mt-1 text-base font-semibold text-zinc-100">
              #
              {channels.find((channel) => channel.id === activeChannelId)
                ?.name ?? "Select a channel"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canResolveApprovals && approvals.length > 0 ? (
              <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-300">
                {approvals.length} approval{approvals.length === 1 ? "" : "s"}{" "}
                pending
              </span>
            ) : null}
            <details className="group relative">
              <summary className="list-none cursor-pointer rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800">
                Admin ▾
              </summary>
              <div className="absolute right-0 z-20 mt-2 min-w-44 rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-lg shadow-black/50">
                <Link
                  href="/admin"
                  className="block rounded-md px-3 py-2 text-xs text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-100"
                >
                  Overview
                </Link>
                <Link
                  href="/admin/agents"
                  className="block rounded-md px-3 py-2 text-xs text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-100"
                >
                  Agents
                </Link>
                <Link
                  href="/admin/activity"
                  className="block rounded-md px-3 py-2 text-xs text-zinc-300 transition hover:bg-zinc-900 hover:text-zinc-100"
                >
                  Activity
                </Link>
              </div>
            </details>
            <button
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800"
              onClick={() => authClient.signOut()}
              type="button"
            >
              Sign out
            </button>
          </div>
        </header>

        {canResolveApprovals ? (
          <ApprovalInbox
            approvals={approvals}
            actorsById={actorsById}
            channelsById={channelsById}
            onResolve={resolveApproval}
          />
        ) : null}

        <div className="flex-1 overflow-y-auto px-6 py-6">
          {messages.length === 0 ? (
            <p className="mt-10 text-center text-sm text-zinc-500">
              No messages yet. Say hi or wait for an agent to post.
            </p>
          ) : null}
          {messages.map((message) => (
            <MessageCard
              key={message.id}
              message={message}
              actorsById={actorsById}
              currentActorId={currentActorId}
              threads={threadsByParentMessage[message.id] ?? []}
              activeThreadId={activeThreadId}
              onCreateThread={createThreadFromMessage}
              onOpenThread={openThread}
            />
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
                <input
                  className="hidden"
                  type="file"
                  onChange={uploadAttachment}
                />
              </label>
              <button
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                type="submit"
                disabled={!activeChannelId}
              >
                Send
              </button>
              {activeThreads.length > 0 ? (
                <span className="text-xs text-zinc-500">
                  {activeThreads.length} thread
                  {activeThreads.length === 1 ? "" : "s"} in channel
                </span>
              ) : null}
            </div>
            {pendingUpload.length > 0 ? (
              <div className="text-xs text-zinc-400">
                Pending attachments:{" "}
                {pendingUpload.map((file) => file.name).join(", ")}
              </div>
            ) : null}
            {error ? <p className="text-xs text-red-400">{error}</p> : null}
          </form>
        </div>
      </main>

      {activeThread ? (
        <ThreadPanel
          threadId={activeThread.id}
          threadIndex={activeThreadIndex >= 0 ? activeThreadIndex : 0}
          threadCount={activeThreadSiblings.length || 1}
          parentMessage={activeThreadParentMessage}
          actorsById={actorsById}
          currentActorId={currentActorId}
          onClose={closeThread}
        />
      ) : null}
    </div>
  );
}
