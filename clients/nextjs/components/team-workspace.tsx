"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { authClient } from "@/lib/auth-client";
import {
  applyCommandSelection,
  applyMentionSelection,
  extractActiveCommandQuery,
  extractActiveMentionQuery,
  parseComposerInput,
  type CommandSuggestion,
} from "@/lib/composer-parts";
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
type ChannelMember = {
  actorId: string;
  role: string;
  createdAt: string;
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
type RegisteredCommand = {
  id: string;
  name: string;
  ownerActorId: string;
  description: string | null;
};
type MemoryUnit = {
  id: string;
  canonicalText: string;
  summary: string;
  keywords: string[];
  sourceVisibility: "private" | "public";
  promoted: boolean;
  promotedAt: string | null;
  promotionSummary: string | null;
  sourceMessageIds: string[];
};
type SearchHit = {
  documentId: string;
  entityType: "actor" | "channel" | "thread" | "message" | "memory";
  entityId: string;
  score: number;
  title: string;
  snippet: string;
  highlights: string[];
  promoted: boolean;
  actorType: "human" | "agent" | "app" | null;
  sourceStreamId: string | null;
};

export function TeamWorkspace() {
  const { data: session } = authClient.useSession();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [channelMembers, setChannelMembers] = useState<ChannelMember[]>([]);
  const [actors, setActors] = useState<ActorRow[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelVisibility, setNewChannelVisibility] = useState<
    "public" | "private"
  >("public");
  const [dmTargetActorId, setDmTargetActorId] = useState("");
  const [privateHumanActorId, setPrivateHumanActorId] = useState("");
  const [privateAgentActorId, setPrivateAgentActorId] = useState("");
  const [privateAppActorId, setPrivateAppActorId] = useState("");
  const [isPrivateSettingsOpen, setIsPrivateSettingsOpen] = useState(false);
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
  const [commands, setCommands] = useState<RegisteredCommand[]>([]);
  const [memoryUnits, setMemoryUnits] = useState<MemoryUnit[]>([]);
  const [memoryAvailable, setMemoryAvailable] = useState(true);
  const [memoryDenied, setMemoryDenied] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchAvailable, setSearchAvailable] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeThreads = threadsByChannel[activeChannelId] ?? [];
  const activeChannel =
    channels.find((channel) => channel.id === activeChannelId) ?? null;
  const isActivePrivateChannel = activeChannel?.visibility === "private";

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
  const dmCandidates = useMemo(
    () => members.filter((member) => member.actorId !== currentActorId),
    [members, currentActorId],
  );
  const currentUserRole = useMemo(() => {
    const row = humanMembers.find((member) => member.actorId === currentActorId);
    return row?.appRole ?? null;
  }, [humanMembers, currentActorId]);
  const canDeleteChannels =
    currentUserRole === "owner" || currentUserRole === "admin";
  const mentionQuery = extractActiveMentionQuery(input);
  const commandQuery = extractActiveCommandQuery(input);
  const commandSuggestions = useMemo<CommandSuggestion[]>(
    () =>
      commands.map((cmd) => ({
        name: cmd.name,
        ownerActorId: cmd.ownerActorId,
        description: cmd.description,
      })),
    [commands],
  );
  const mentionSuggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.trim().toLowerCase();
    return actors
      .filter((actor) => actor.actorId !== currentActorId)
      .filter((actor) =>
        q.length === 0
          ? true
          : actor.displayName.toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [actors, mentionQuery, currentActorId]);
  const slashSuggestions = useMemo(() => {
    if (commandQuery === null) return [];
    const q = commandQuery.trim().toLowerCase();
    return commandSuggestions
      .filter((cmd) => (q.length === 0 ? true : cmd.name.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [commandSuggestions, commandQuery]);
  const channelMemberActorIds = useMemo(
    () => new Set(channelMembers.map((member) => member.actorId)),
    [channelMembers],
  );
  const availablePrivateHumans = useMemo(
    () =>
      actors.filter(
        (actor) =>
          actor.actorType === "human" && !channelMemberActorIds.has(actor.actorId),
      ),
    [actors, channelMemberActorIds],
  );
  const availablePrivateAgents = useMemo(
    () =>
      actors.filter(
        (actor) =>
          actor.actorType === "agent" && !channelMemberActorIds.has(actor.actorId),
      ),
    [actors, channelMemberActorIds],
  );
  const availablePrivateApps = useMemo(
    () =>
      actors.filter(
        (actor) =>
          actor.actorType === "app" && !channelMemberActorIds.has(actor.actorId),
      ),
    [actors, channelMemberActorIds],
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

  async function refreshCommands(channelId: string) {
    const result = await api<{ commands: RegisteredCommand[] }>(
      `/api/team/commands?channelId=${encodeURIComponent(channelId)}`,
    );
    setCommands(result.commands);
  }

  async function refreshChannelMembers(channelId: string) {
    const result = await api<{ members: ChannelMember[] }>(
      `/api/team/channels/${channelId}/members`,
    );
    setChannelMembers(result.members);
  }

  async function refreshMemory(channelId: string) {
    const result = await api<{
      units: MemoryUnit[];
      available?: boolean;
      denied?: boolean;
    }>(`/api/team/memory?streamId=${encodeURIComponent(channelId)}`);
    setMemoryUnits(result.units);
    setMemoryAvailable(result.available !== false);
    setMemoryDenied(result.denied === true);
  }

  async function promoteMemoryUnit(memoryId: string) {
    if (!activeChannelId) return;
    try {
      await api(`/api/team/memory/${memoryId}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      await refreshMemory(activeChannelId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function runSearch(query: string) {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setSearchHits([]);
      return;
    }
    try {
      const result = await api<{
        hits: SearchHit[];
        available?: boolean;
      }>(`/api/team/search?q=${encodeURIComponent(trimmed)}&limit=12`);
      setSearchHits(result.hits);
      setSearchAvailable(result.available !== false);
    } catch (err) {
      setError((err as Error).message);
    }
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
    void refreshCommands(activeChannelId).catch((err) =>
      setError((err as Error).message),
    );
    void refreshChannelMembers(activeChannelId).catch(() => {
      // channel member listing is optional for restricted channels
    });
    void refreshMemory(activeChannelId).catch(() => {
      // memory plugin is optional
    });
    const timer = setInterval(() => {
      void refreshMessages(activeChannelId).catch(() => {});
      void refreshThreads(activeChannelId).catch(() => {});
      void refreshApprovals().catch(() => {});
      void refreshDirectory().catch(() => {});
      void refreshWebhooks().catch(() => {});
      void refreshCommands(activeChannelId).catch(() => {});
      void refreshChannelMembers(activeChannelId).catch(() => {});
      void refreshMemory(activeChannelId).catch(() => {});
    }, 2200);
    return () => clearInterval(timer);
  }, [activeChannelId]);

  useEffect(() => {
    if (isActivePrivateChannel) return;
    setPrivateHumanActorId("");
    setPrivateAgentActorId("");
    setPrivateAppActorId("");
    setIsPrivateSettingsOpen(false);
    setChannelMembers([]);
  }, [isActivePrivateChannel]);

  useEffect(() => {
    if (!searchOpen) return;
    const handle = setTimeout(() => {
      void runSearch(searchQuery);
    }, 200);
    return () => clearTimeout(handle);
  }, [searchQuery, searchOpen]);

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
    const parsed = parseComposerInput({
      text: input,
      actors: actors.map((actor) => ({
        actorId: actor.actorId,
        displayName: actor.displayName,
        actorType: actor.actorType,
      })),
      commands: commandSuggestions,
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
      await api(`/api/team/channels/${activeChannelId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
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
        body: JSON.stringify({
          name,
          visibility: newChannelVisibility,
        }),
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
      setNewChannelVisibility("public");
      await refreshDirectory();
      setActiveChannelId(payload.channelId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function startDirectMessage() {
    const targetActorId = dmTargetActorId.trim();
    if (!targetActorId) return;
    const me =
      members.find((member) => member.actorId === currentActorId)?.displayName ??
      "me";
    const target =
      members.find((member) => member.actorId === targetActorId)?.displayName ??
      "direct";
    const dmName = `dm-${me}-${target}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    try {
      const response = await fetch("/api/team/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: dmName.length > 0 ? dmName : `dm-${targetActorId.slice(0, 8)}`,
          visibility: "private",
          memberActorIds: [targetActorId],
        }),
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
            `DM request submitted for admin approval (${payload.permissionRequestId}).`,
          );
        }
        throw new Error(payload.error ?? `request failed: ${response.status}`);
      }
      if (!payload.channelId) {
        throw new Error("dm creation did not return a channel id");
      }
      setDmTargetActorId("");
      await refreshDirectory();
      setActiveChannelId(payload.channelId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function addPrivateChannelAttendee(actorId: string) {
    if (!activeChannelId) return;
    const candidate = actorId.trim();
    if (!candidate) return;
    try {
      await api(`/api/team/channels/${activeChannelId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actorId: candidate, role: "member" }),
      });
      await refreshChannelMembers(activeChannelId);
      setPrivateHumanActorId("");
      setPrivateAgentActorId("");
      setPrivateAppActorId("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removePrivateChannelAttendee(actorId: string) {
    if (!activeChannelId) return;
    try {
      await api(`/api/team/channels/${activeChannelId}/members/${actorId}`, {
        method: "DELETE",
      });
      await refreshChannelMembers(activeChannelId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteExistingChannel(channelId: string, channelName: string) {
    if (!canDeleteChannels) return;
    const confirmed = window.confirm(
      `Delete #${channelName}? This also removes its threads and messages.`,
    );
    if (!confirmed) return;
    try {
      await api(`/api/team/channels/${channelId}`, {
        method: "DELETE",
      });
      await refreshDirectory();
      if (activeChannelId === channelId) {
        const refreshed = await api<{ channels: Channel[] }>("/api/team/channels");
        const nextChannelId = refreshed.channels[0]?.id ?? "";
        setActiveChannelId(nextChannelId);
      }
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
            <div
              key={channel.id}
              className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 transition ${
                channel.id === activeChannelId
                  ? "border-emerald-500/40 bg-emerald-500/15"
                  : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-900"
              }`}
            >
              <button
                className="min-w-0 flex-1 px-1 py-0.5 text-left text-sm text-zinc-200"
                onClick={() => setActiveChannelId(channel.id)}
                type="button"
              >
                <span className="truncate">#{channel.name}</span>
                <span className="ml-2 text-[10px] uppercase tracking-wide text-zinc-500">
                  {channel.visibility}
                </span>
              </button>
              {canDeleteChannels ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void deleteExistingChannel(channel.id, channel.name);
                  }}
                  className="rounded border border-zinc-700 px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-400 transition hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-300"
                >
                  Delete
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-3 py-2 text-sm outline-none transition focus:border-emerald-500/70"
            placeholder="new channel"
            value={newChannelName}
            onChange={(event) => setNewChannelName(event.target.value)}
          />
          <select
            className="rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-2 py-2 text-xs uppercase text-zinc-300"
            value={newChannelVisibility}
            onChange={(event) =>
              setNewChannelVisibility(
                event.target.value === "private" ? "private" : "public",
              )
            }
          >
            <option value="public">public</option>
            <option value="private">private</option>
          </select>
          <button
            className="rounded-lg bg-zinc-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-900 transition hover:bg-white"
            onClick={createNewChannel}
            type="button"
          >
            Add
          </button>
        </div>
        <div className="mt-2 flex gap-2">
          <select
            className="min-w-0 flex-1 rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-3 py-2 text-xs text-zinc-200"
            value={dmTargetActorId}
            onChange={(event) => setDmTargetActorId(event.target.value)}
          >
            <option value="">start DM with…</option>
            {dmCandidates.map((member) => (
              <option key={member.actorId} value={member.actorId}>
                {member.displayName} ({member.actorType})
              </option>
            ))}
          </select>
          <button
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800 disabled:opacity-50"
            onClick={startDirectMessage}
            type="button"
            disabled={!dmTargetActorId}
          >
            DM
          </button>
        </div>

        {isActivePrivateChannel ? (
          <button
            type="button"
            onClick={() => setIsPrivateSettingsOpen(true)}
            className="mt-4 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800"
          >
            Manage private channel
          </button>
        ) : null}

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
            Memory
          </p>
          {!memoryAvailable ? (
            <p className="mt-2">Memory plugin is not enabled.</p>
          ) : memoryDenied ? (
            <p className="mt-2">No access to this channel&apos;s memory.</p>
          ) : memoryUnits.length === 0 ? (
            <p className="mt-2">No derived memory yet for this channel.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {memoryUnits.map((unit) => (
                <li
                  key={unit.id}
                  className="rounded-md border border-zinc-800 bg-zinc-900/80 px-2 py-2"
                >
                  <p className="break-words text-zinc-200">{unit.summary}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] uppercase tracking-wide">
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">
                      {unit.sourceVisibility}
                    </span>
                    {unit.promoted ? (
                      <span className="rounded bg-yellow-500/20 px-1.5 py-0.5 text-yellow-200">
                        ★ promoted
                      </span>
                    ) : null}
                    <span className="text-zinc-500">
                      {unit.sourceMessageIds.length} src
                    </span>
                  </div>
                  {unit.keywords.length > 0 ? (
                    <p className="mt-1 truncate text-[10px] text-zinc-500">
                      kw: {unit.keywords.slice(0, 5).join(", ")}
                    </p>
                  ) : null}
                  {!unit.promoted ? (
                    <button
                      type="button"
                      onClick={() => void promoteMemoryUnit(unit.id)}
                      className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 transition hover:bg-zinc-800"
                    >
                      Promote org-wide
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 border-t border-zinc-800/60 pt-2 text-[11px] text-zinc-500">
            Derived from <code>message.appended</code> events. Source
            visibility is snapshotted; promotion requires{" "}
            <code>memory:promote</code>.
          </p>
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
          <div className="relative mx-4 hidden max-w-md flex-1 md:block">
            <input
              type="search"
              placeholder="Search actors, channels, threads, messages, memory…"
              value={searchQuery}
              onFocus={() => setSearchOpen(true)}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setSearchOpen(true);
              }}
              onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-emerald-500/70"
            />
            {searchOpen && searchQuery.trim().length > 0 ? (
              <div className="absolute left-0 right-0 z-30 mt-1 max-h-96 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl shadow-black/60">
                {!searchAvailable ? (
                  <p className="px-4 py-3 text-xs text-zinc-500">
                    Search plugin is not enabled.
                  </p>
                ) : searchHits.length === 0 ? (
                  <p className="px-4 py-3 text-xs text-zinc-500">No matches.</p>
                ) : (
                  <ul className="divide-y divide-zinc-900">
                    {searchHits.map((hit) => (
                      <li key={hit.documentId}>
                        <button
                          type="button"
                          className="block w-full px-4 py-2 text-left text-sm text-zinc-200 transition hover:bg-zinc-900"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            if (hit.entityType === "channel") {
                              setActiveChannelId(hit.entityId);
                              setSearchOpen(false);
                            } else if (
                              (hit.entityType === "message" ||
                                hit.entityType === "memory") &&
                              hit.sourceStreamId &&
                              channels.some(
                                (c) => c.id === hit.sourceStreamId,
                              )
                            ) {
                              setActiveChannelId(hit.sourceStreamId);
                              setSearchOpen(false);
                            }
                          }}
                        >
                          <div className="flex items-center gap-2">
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                              {hit.entityType}
                              {hit.actorType ? `·${hit.actorType}` : ""}
                            </span>
                            <span className="truncate font-medium">
                              {hit.title}
                            </span>
                            {hit.promoted ? (
                              <span className="text-[10px] text-yellow-300">
                                ★
                              </span>
                            ) : null}
                          </div>
                          {hit.snippet ? (
                            <p className="mt-1 truncate text-[11px] text-zinc-500">
                              {hit.snippet}
                            </p>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
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
            <div className="relative">
              <textarea
                className="h-28 w-full rounded-xl border border-zinc-700/80 bg-zinc-900/80 p-3 text-sm leading-relaxed outline-none transition focus:border-emerald-500/70"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder="Send a message... (@mention, /command)"
              />
              {mentionQuery !== null && mentionSuggestions.length > 0 ? (
                <div className="absolute left-2 right-2 top-2 z-10 max-h-48 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900/95 p-1 shadow-xl">
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
                <div className="absolute left-2 right-2 top-2 z-10 max-h-48 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900/95 p-1 shadow-xl">
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
              <span className="text-xs text-zinc-500">
                Tip: use <code>@name</code> and <code>/poem</code>
              </span>
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
          commands={commandSuggestions}
          currentActorId={currentActorId}
          onClose={closeThread}
        />
      ) : null}

      {isActivePrivateChannel && isPrivateSettingsOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
          onClick={() => setIsPrivateSettingsOpen(false)}
        >
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-950 p-5 shadow-2xl shadow-black/70"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-[0.14em] text-zinc-300">
                  Private channel settings
                </h3>
                <p className="mt-1 text-xs text-zinc-500">
                  Configure which humans, agents, and apps can attend this
                  channel.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsPrivateSettingsOpen(false)}
                className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-900"
              >
                Close
              </button>
            </div>

            <div className="mt-4 space-y-2">
              <div className="flex gap-2">
                <select
                  className="min-w-0 flex-1 rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-2 py-2 text-xs text-zinc-200"
                  value={privateHumanActorId}
                  onChange={(event) => setPrivateHumanActorId(event.target.value)}
                >
                  <option value="">add human…</option>
                  {availablePrivateHumans.map((actor) => (
                    <option key={actor.actorId} value={actor.actorId}>
                      {actor.displayName}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void addPrivateChannelAttendee(privateHumanActorId)}
                  disabled={!privateHumanActorId}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[11px] uppercase tracking-wide text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Add
                </button>
              </div>
              <div className="flex gap-2">
                <select
                  className="min-w-0 flex-1 rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-2 py-2 text-xs text-zinc-200"
                  value={privateAgentActorId}
                  onChange={(event) => setPrivateAgentActorId(event.target.value)}
                >
                  <option value="">add agent…</option>
                  {availablePrivateAgents.map((actor) => (
                    <option key={actor.actorId} value={actor.actorId}>
                      {actor.displayName}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void addPrivateChannelAttendee(privateAgentActorId)}
                  disabled={!privateAgentActorId}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[11px] uppercase tracking-wide text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Add
                </button>
              </div>
              <div className="flex gap-2">
                <select
                  className="min-w-0 flex-1 rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-2 py-2 text-xs text-zinc-200"
                  value={privateAppActorId}
                  onChange={(event) => setPrivateAppActorId(event.target.value)}
                >
                  <option value="">add app…</option>
                  {availablePrivateApps.map((actor) => (
                    <option key={actor.actorId} value={actor.actorId}>
                      {actor.displayName}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void addPrivateChannelAttendee(privateAppActorId)}
                  disabled={!privateAppActorId}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[11px] uppercase tracking-wide text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800 disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </div>

            <div className="mt-4 border-t border-zinc-800/60 pt-3">
              <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                Current attendees
              </p>
              {channelMembers.length === 0 ? (
                <p className="mt-2 text-xs text-zinc-500">No attendees yet.</p>
              ) : (
                <ul className="mt-2 space-y-1.5 text-sm">
                  {channelMembers.map((attendee) => {
                    const actor = actorsById[attendee.actorId];
                    const actorType = actor?.actorType ?? "unknown";
                    const displayName = actor?.displayName ?? attendee.actorId;
                    return (
                      <li
                        key={attendee.actorId}
                        className="flex items-center justify-between gap-2 rounded border border-zinc-800/80 bg-zinc-900/60 px-2 py-1.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-zinc-200">{displayName}</p>
                          <p className="text-[10px] uppercase tracking-wide text-zinc-500">
                            {actorType} · {attendee.role}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            void removePrivateChannelAttendee(attendee.actorId)
                          }
                          className="rounded border border-zinc-700 px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-400 transition hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-300"
                        >
                          Remove
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
