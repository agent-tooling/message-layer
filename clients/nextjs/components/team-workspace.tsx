"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Hash,
  Lock,
  Plus,
  Search,
  Settings,
  LogOut,
  Users,
  Bot,
  Brain,
  Webhook,
  MessageSquare,
  Send,
  Paperclip,
  ShieldCheck,
  ChevronDown,
  AtSign,
  Slash,
  X,
  Star,
  Globe,
  UserPlus,
  MailPlus,
  Copy,
  Trash2,
  CheckCircle,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { CollapsibleSection } from "@/components/ui/section";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { Toaster, toast } from "@/components/ui/toast";

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
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("Message Layer");

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
    void api<{ hasWorkspace: boolean; workspaceName: string | null }>(
      "/api/team/setup",
    ).then((result) => {
      if (result.workspaceName) setWorkspaceName(result.workspaceName);
    }).catch(() => {});
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
    void refreshWebhooks().catch(() => {});
    void refreshApprovals().catch(() => {});
  }, [session]);

  useEffect(() => {
    if (!activeChannelId) return;
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
    void refreshChannelMembers(activeChannelId).catch(() => {});
    void refreshMemory(activeChannelId).catch(() => {});
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
      setShowNewChannel(false);
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
    if (commandQuery !== null && slashSuggestions.length > 0) {
      event.preventDefault();
      selectCommand(slashSuggestions[0].name);
      return;
    }
    if (mentionQuery !== null && mentionSuggestions.length > 0) return;
    event.preventDefault();
    void sendMessage(event as unknown as React.FormEvent);
  }

  function copyInviteLink() {
    if (!inviteLink) return;
    void navigator.clipboard?.writeText(inviteLink).then(() => {
      toast.success("Invite link copied to clipboard");
    }).catch(() => {});
  }

  const publicChannels = channels.filter((c) => c.visibility === "public");
  const privateChannels = channels.filter((c) => c.visibility === "private");

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      {/* ─── Sidebar ─── */}
      <aside className="flex w-72 flex-col border-r border-zinc-800/60 bg-zinc-950">
        {/* Workspace header */}
        <div className="flex items-center justify-between px-4 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight text-zinc-100">
              {workspaceName}
            </h2>
            <p className="text-[11px] text-zinc-500">
              {humanMembers.length + agents.length} member{humanMembers.length + agents.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip content="Invite teammate">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowInvite(true)}
              >
                <UserPlus className="h-4 w-4" />
              </Button>
            </Tooltip>
          </div>
        </div>

        <Separator />

        {/* Sidebar content */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {/* Channels */}
          <CollapsibleSection
            title="Channels"
            icon={<Hash className="h-3.5 w-3.5" />}
            badge={
              <Tooltip content="New channel">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowNewChannel(!showNewChannel);
                  }}
                  className="ml-auto rounded p-0.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            }
          >
            {showNewChannel && (
              <div className="mb-2 space-y-2 rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-2.5">
                <Input
                  placeholder="Channel name"
                  value={newChannelName}
                  onChange={(e) => setNewChannelName(e.target.value)}
                  className="h-8 text-xs"
                />
                <div className="flex gap-2">
                  <Select
                    className="h-8 flex-1 text-xs"
                    value={newChannelVisibility}
                    onChange={(e) =>
                      setNewChannelVisibility(
                        e.target.value === "private" ? "private" : "public",
                      )
                    }
                  >
                    <option value="public">Public</option>
                    <option value="private">Private</option>
                  </Select>
                  <Button size="sm" onClick={createNewChannel}>
                    Create
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-0.5">
              {publicChannels.map((channel) => (
                <ChannelItem
                  key={channel.id}
                  channel={channel}
                  isActive={channel.id === activeChannelId}
                  canDelete={canDeleteChannels}
                  onClick={() => setActiveChannelId(channel.id)}
                  onDelete={() =>
                    void deleteExistingChannel(channel.id, channel.name)
                  }
                />
              ))}
            </div>

            {privateChannels.length > 0 && (
              <div className="mt-2">
                <p className="mb-1 px-2 text-[10px] font-medium uppercase tracking-wider text-zinc-600">
                  Private
                </p>
                <div className="space-y-0.5">
                  {privateChannels.map((channel) => (
                    <ChannelItem
                      key={channel.id}
                      channel={channel}
                      isActive={channel.id === activeChannelId}
                      canDelete={canDeleteChannels}
                      onClick={() => setActiveChannelId(channel.id)}
                      onDelete={() =>
                        void deleteExistingChannel(channel.id, channel.name)
                      }
                    />
                  ))}
                </div>
              </div>
            )}
          </CollapsibleSection>

          {/* Direct messages */}
          <div className="mt-3">
            <CollapsibleSection
              title="Direct Messages"
              icon={<MessageSquare className="h-3.5 w-3.5" />}
            >
              <div className="flex gap-1.5">
                <Select
                  className="h-8 flex-1 text-xs"
                  value={dmTargetActorId}
                  onChange={(e) => setDmTargetActorId(e.target.value)}
                >
                  <option value="">Select…</option>
                  {dmCandidates.map((member) => (
                    <option key={member.actorId} value={member.actorId}>
                      {member.displayName} ({member.actorType})
                    </option>
                  ))}
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={startDirectMessage}
                  disabled={!dmTargetActorId}
                >
                  <Send className="h-3 w-3" />
                </Button>
              </div>
            </CollapsibleSection>
          </div>

          <Separator className="my-3" />

          {/* People */}
          <CollapsibleSection
            title="People"
            icon={<Users className="h-3.5 w-3.5" />}
            badge={
              <Badge variant="secondary" className="ml-auto">
                {humanMembers.length}
              </Badge>
            }
            defaultOpen={false}
          >
            <div className="space-y-1">
              {humanMembers.map((member) => {
                const isMe = member.actorId === currentActorId;
                return (
                  <div
                    key={member.actorId}
                    className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-zinc-800/50"
                  >
                    <div className="relative">
                      <Avatar
                        name={member.displayName}
                        type={member.actorType}
                        size="sm"
                      />
                      {isMe && (
                        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-zinc-950 bg-emerald-400" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-zinc-200">
                        {member.displayName}
                        {isMe && <span className="ml-1 text-[10px] text-zinc-500">(you)</span>}
                      </p>
                      <div className="flex items-center gap-1">
                        {member.appRole && (
                          <Badge variant={member.appRole === "owner" ? "amber" : member.appRole === "admin" ? "sky" : "secondary"} className="text-[9px]">
                            {member.appRole}
                          </Badge>
                        )}
                      </div>
                    </div>
                    {member.appRole !== "owner" && (
                      <Select
                        className="hidden h-6 w-20 text-[10px] group-hover:block"
                        value={member.appRole ?? "member"}
                        onChange={(e) =>
                          void updateMemberRole(
                            member.actorId,
                            e.target.value === "admin" ? "admin" : "member",
                          )
                        }
                      >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                      </Select>
                    )}
                  </div>
                );
              })}
              {humanMembers.length === 0 && (
                <p className="px-2 text-xs text-zinc-500">No members yet.</p>
              )}
            </div>
          </CollapsibleSection>

          {/* Agents */}
          <div className="mt-2">
            <CollapsibleSection
              title="Agents"
              icon={<Bot className="h-3.5 w-3.5" />}
              badge={
                <Badge variant="emerald" className="ml-auto">
                  {agents.length}
                </Badge>
              }
              defaultOpen={false}
            >
              {agents.length > 0 ? (
                <div className="space-y-1">
                  {agents.map((agent) => (
                    <div
                      key={agent.actorId}
                      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-zinc-800/50"
                    >
                      <Avatar
                        name={agent.displayName}
                        type="agent"
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-zinc-200">
                          {agent.displayName}
                        </p>
                        <p className="truncate text-[10px] text-zinc-500">
                          {agent.actorId.slice(0, 8)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-2 text-xs text-zinc-500">
                  No agents onboarded yet.
                </p>
              )}
            </CollapsibleSection>
          </div>

          {/* Memory */}
          <div className="mt-2">
            <CollapsibleSection
              title="Memory"
              icon={<Brain className="h-3.5 w-3.5" />}
              defaultOpen={false}
            >
              {!memoryAvailable ? (
                <p className="px-2 text-xs text-zinc-500">
                  Memory plugin is not enabled.
                </p>
              ) : memoryDenied ? (
                <p className="px-2 text-xs text-zinc-500">
                  No access to this channel&apos;s memory.
                </p>
              ) : memoryUnits.length === 0 ? (
                <p className="px-2 text-xs text-zinc-500">
                  No derived memory yet.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {memoryUnits.map((unit) => (
                    <div
                      key={unit.id}
                      className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-2.5 py-2"
                    >
                      <p className="text-xs leading-relaxed text-zinc-300">
                        {unit.summary}
                      </p>
                      <div className="mt-1.5 flex items-center gap-1">
                        <Badge variant="secondary">
                          {unit.sourceVisibility}
                        </Badge>
                        {unit.promoted && (
                          <Badge variant="amber">
                            <Star className="mr-0.5 h-2.5 w-2.5" />
                            promoted
                          </Badge>
                        )}
                        <span className="text-[10px] text-zinc-600">
                          {unit.sourceMessageIds.length} src
                        </span>
                      </div>
                      {!unit.promoted && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-1.5 h-6 w-full text-[10px]"
                          onClick={() => void promoteMemoryUnit(unit.id)}
                        >
                          <Globe className="mr-1 h-3 w-3" />
                          Promote org-wide
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CollapsibleSection>
          </div>

          {/* Webhooks */}
          <div className="mt-2">
            <CollapsibleSection
              title="Webhooks"
              icon={<Webhook className="h-3.5 w-3.5" />}
              defaultOpen={false}
            >
              {!webhooksAvailable ? (
                <p className="px-2 text-xs text-zinc-500">
                  Webhook plugin is not enabled.
                </p>
              ) : webhooks.length === 0 ? (
                <p className="px-2 text-xs text-zinc-500">
                  No webhook subscriptions yet.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {webhooks.map((hook) => (
                    <div
                      key={hook.id}
                      className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-2.5 py-2"
                    >
                      <p className="truncate text-xs text-zinc-300">
                        {hook.endpoint}
                      </p>
                      <p className="mt-0.5 text-[10px] text-zinc-500">
                        {hook.eventTypes.join(", ")}
                        {hook.streamId
                          ? ` · ${hook.streamId.slice(0, 8)}`
                          : " · org-wide"}
                      </p>
                      {!hook.enabled && (
                        <Badge variant="amber" className="mt-1">
                          disabled
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CollapsibleSection>
          </div>

          {/* Private channel settings */}
          {isActivePrivateChannel && (
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setIsPrivateSettingsOpen(true)}
              >
                <Settings className="mr-1.5 h-3.5 w-3.5" />
                Manage private channel
              </Button>
            </div>
          )}
        </div>

        {/* User footer */}
        <Separator />
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Avatar
            name={session?.user?.email ?? "U"}
            type="human"
            size="sm"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-zinc-300">
              {session?.user?.email ?? "unknown"}
            </p>
          </div>
          <Tooltip content="Sign out">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => authClient.signOut()}
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
        </div>
      </aside>

      {/* ─── Main content ─── */}
      <main className="flex flex-1 flex-col">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-zinc-800/60 bg-zinc-950/80 px-5 py-3">
          <div className="flex items-center gap-3">
            {activeChannel?.visibility === "private" ? (
              <Lock className="h-4 w-4 text-zinc-500" />
            ) : (
              <Hash className="h-4 w-4 text-zinc-500" />
            )}
            <div>
              <h1 className="text-sm font-semibold text-zinc-100">
                {activeChannel?.name ?? "Select a channel"}
              </h1>
              {activeThreads.length > 0 && (
                <p className="text-[11px] text-zinc-500">
                  {activeThreads.length} thread
                  {activeThreads.length === 1 ? "" : "s"}
                </p>
              )}
            </div>
          </div>

          {/* Search */}
          <div className="relative mx-4 hidden max-w-md flex-1 md:block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <Input
              type="search"
              placeholder="Search messages, channels, memory…"
              value={searchQuery}
              onFocus={() => setSearchOpen(true)}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSearchOpen(true);
              }}
              onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
              className="h-8 pl-9 text-xs"
            />
            {searchOpen && searchQuery.trim().length > 0 && (
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
                          className="block w-full px-4 py-2.5 text-left text-sm text-zinc-200 transition hover:bg-zinc-900/60"
                          onMouseDown={(e) => e.preventDefault()}
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
                            <Badge variant="secondary">
                              {hit.entityType}
                              {hit.actorType ? ` · ${hit.actorType}` : ""}
                            </Badge>
                            <span className="truncate text-xs font-medium">
                              {hit.title}
                            </span>
                            {hit.promoted && (
                              <Star className="h-3 w-3 text-yellow-400" />
                            )}
                          </div>
                          {hit.snippet && (
                            <p className="mt-1 truncate text-[11px] text-zinc-500">
                              {hit.snippet}
                            </p>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {canResolveApprovals && approvals.length > 0 && (
              <Badge variant="amber" className="gap-1 text-[11px]">
                <ShieldCheck className="h-3 w-3" />
                {approvals.length} pending
              </Badge>
            )}
            <details className="group relative">
              <summary className="inline-flex list-none cursor-pointer items-center gap-1 rounded-lg border border-zinc-700 bg-transparent px-3 py-2 text-xs font-medium text-zinc-200 shadow-sm transition hover:bg-zinc-800 hover:text-zinc-100">
                <Settings className="h-3.5 w-3.5" />
                Admin
                <ChevronDown className="h-3 w-3" />
              </summary>
              <div className="absolute right-0 z-20 mt-1.5 min-w-44 rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-lg shadow-black/50">
                <Link
                  href="/admin"
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-zinc-300 transition hover:bg-zinc-800/80 hover:text-zinc-100"
                >
                  Overview
                </Link>
                <Link
                  href="/admin/agents"
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-zinc-300 transition hover:bg-zinc-800/80 hover:text-zinc-100"
                >
                  <Bot className="h-3.5 w-3.5" />
                  Agents
                </Link>
                <Link
                  href="/admin/activity"
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-zinc-300 transition hover:bg-zinc-800/80 hover:text-zinc-100"
                >
                  Activity
                </Link>
              </div>
            </details>
          </div>
        </header>

        {/* Approval inbox */}
        {canResolveApprovals && (
          <ApprovalInbox
            approvals={approvals}
            actorsById={actorsById}
            channelsById={channelsById}
            onResolve={resolveApproval}
          />
        )}

        {/* Message list */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {messages.length === 0 ? (
            <EmptyState
              icon={<MessageSquare className="h-8 w-8" />}
              title="No messages yet"
              description="Say hi or wait for an agent to post."
            />
          ) : (
            <div>
              {messages.map((message, idx) => {
                const prev = idx > 0 ? messages[idx - 1] : null;
                const isGrouped =
                  prev !== null &&
                  prev.actorId === message.actorId &&
                  new Date(message.createdAt).getTime() -
                    new Date(prev.createdAt).getTime() <
                    5 * 60 * 1000;
                return (
                  <MessageCard
                    key={message.id}
                    message={message}
                    actorsById={actorsById}
                    currentActorId={currentActorId}
                    threads={threadsByParentMessage[message.id] ?? []}
                    activeThreadId={activeThreadId}
                    onCreateThread={createThreadFromMessage}
                    onOpenThread={openThread}
                    isGrouped={isGrouped}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-zinc-800/60 bg-zinc-950/90 px-5 py-3">
          <form onSubmit={sendMessage}>
            <div className="relative">
              <Textarea
                className="min-h-[80px] resize-none pr-12"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={`Message #${activeChannel?.name ?? "channel"}… (use @mention or /command)`}
              />
              {/* Mention suggestions */}
              {mentionQuery !== null && mentionSuggestions.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-48 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900/95 p-1 shadow-xl">
                  {mentionSuggestions.map((actor) => (
                    <button
                      key={actor.actorId}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition hover:bg-zinc-800"
                      onClick={() => selectMention(actor.displayName)}
                    >
                      <AtSign className="h-3 w-3 text-sky-400" />
                      <span className="text-zinc-200">{actor.displayName}</span>
                      <Badge variant="secondary" className="ml-auto">
                        {actor.actorType}
                      </Badge>
                    </button>
                  ))}
                </div>
              )}
              {/* Command suggestions */}
              {commandQuery !== null && slashSuggestions.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-48 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900/95 p-1 shadow-xl">
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
                <Paperclip className="h-3.5 w-3.5" />
                Attach
                <input
                  className="hidden"
                  type="file"
                  onChange={uploadAttachment}
                />
              </label>
              <div className="flex-1" />
              {pendingUpload.length > 0 && (
                <span className="text-[11px] text-zinc-500">
                  {pendingUpload.length} file{pendingUpload.length > 1 ? "s" : ""} attached
                </span>
              )}
              <Button type="submit" size="sm" disabled={!activeChannelId}>
                <Send className="mr-1 h-3.5 w-3.5" />
                Send
              </Button>
            </div>
            {error && (
              <p className="mt-2 text-xs text-red-400">{error}</p>
            )}
          </form>
        </div>
      </main>

      {/* Thread panel */}
      {activeThread && (
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
      )}

      {/* Private channel settings dialog */}
      <Dialog
        open={isActivePrivateChannel && isPrivateSettingsOpen}
        onClose={() => setIsPrivateSettingsOpen(false)}
      >
        <DialogHeader onClose={() => setIsPrivateSettingsOpen(false)}>
          <DialogTitle>Private channel settings</DialogTitle>
          <DialogDescription>
            Configure which humans, agents, and apps can attend this channel.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <AddMemberRow
            label="Add human"
            options={availablePrivateHumans}
            value={privateHumanActorId}
            onChange={setPrivateHumanActorId}
            onAdd={() => void addPrivateChannelAttendee(privateHumanActorId)}
          />
          <AddMemberRow
            label="Add agent"
            options={availablePrivateAgents}
            value={privateAgentActorId}
            onChange={setPrivateAgentActorId}
            onAdd={() => void addPrivateChannelAttendee(privateAgentActorId)}
          />
          <AddMemberRow
            label="Add app"
            options={availablePrivateApps}
            value={privateAppActorId}
            onChange={setPrivateAppActorId}
            onAdd={() => void addPrivateChannelAttendee(privateAppActorId)}
          />
        </div>

        <Separator className="my-4" />

        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Current attendees
          </p>
          {channelMembers.length === 0 ? (
            <p className="text-xs text-zinc-500">No attendees yet.</p>
          ) : (
            <div className="space-y-1.5">
              {channelMembers.map((attendee) => {
                const actor = actorsById[attendee.actorId];
                const actorType = actor?.actorType ?? "unknown";
                const displayName = actor?.displayName ?? attendee.actorId;
                return (
                  <div
                    key={attendee.actorId}
                    className="flex items-center gap-2.5 rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2"
                  >
                    <Avatar name={displayName} type={actorType} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-zinc-200">
                        {displayName}
                      </p>
                      <div className="flex gap-1">
                        <Badge variant="secondary">{actorType}</Badge>
                        <Badge variant="secondary">{attendee.role}</Badge>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        void removePrivateChannelAttendee(attendee.actorId)
                      }
                      className="h-7 w-7 text-zinc-500 hover:text-red-400"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Dialog>

      {/* Invite dialog */}
      <Dialog open={showInvite} onClose={() => setShowInvite(false)}>
        <DialogHeader onClose={() => setShowInvite(false)}>
          <DialogTitle>
            <MailPlus className="mr-2 inline h-4 w-4" />
            Invite teammate
          </DialogTitle>
          <DialogDescription>
            Send an invite link to add people to your workspace.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-[11px] font-medium text-zinc-400">
                Email address
              </label>
              <Input
                placeholder="teammate@company.com"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-medium text-zinc-400">
                Role
              </label>
              <Select
                value={inviteRole}
                onChange={(e) =>
                  setInviteRole(e.target.value === "admin" ? "admin" : "member")
                }
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </Select>
              <p className="mt-1 text-[10px] text-zinc-600">
                {inviteRole === "admin" ? "Can manage channels, agents, and approve requests." : "Can send messages and join channels."}
              </p>
            </div>
            <Button className="w-full" onClick={createInvite}>
              <MailPlus className="mr-1.5 h-3.5 w-3.5" />
              Generate invite link
            </Button>
          </div>
          {inviteLink && (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.03] p-4">
              <div className="mb-2 flex items-center gap-2">
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/15">
                  <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
                </div>
                <p className="text-xs font-medium text-emerald-300">Invite link ready</p>
              </div>
              <div className="rounded-lg border border-zinc-800/60 bg-zinc-950/60 px-3 py-2">
                <p className="break-all font-mono text-[11px] leading-relaxed text-zinc-300">{inviteLink}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-2.5 w-full"
                onClick={copyInviteLink}
              >
                <Copy className="mr-1.5 h-3 w-3" />
                Copy to clipboard
              </Button>
              <p className="mt-2 text-center text-[10px] text-zinc-600">
                Share this link with your teammate to join the workspace.
              </p>
            </div>
          )}
        </div>
      </Dialog>

      <Toaster />
    </div>
  );
}

/* ── Subcomponents ── */

function ChannelItem({
  channel,
  isActive,
  canDelete,
  onClick,
  onDelete,
}: {
  channel: Channel;
  isActive: boolean;
  canDelete: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition",
        isActive
          ? "bg-emerald-500/10 text-emerald-200"
          : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200",
      )}
    >
      {channel.visibility === "private" ? (
        <Lock className="h-3.5 w-3.5 shrink-0 opacity-60" />
      ) : (
        <Hash className="h-3.5 w-3.5 shrink-0 opacity-60" />
      )}
      <button
        type="button"
        onClick={onClick}
        className="min-w-0 flex-1 truncate text-left text-xs font-medium"
      >
        {channel.name}
      </button>
      {canDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="hidden rounded p-0.5 text-zinc-600 transition hover:bg-red-500/10 hover:text-red-400 group-hover:block"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function AddMemberRow({
  label,
  options,
  value,
  onChange,
  onAdd,
}: {
  label: string;
  options: ActorRow[];
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex gap-2">
      <Select
        className="flex-1 text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{label}…</option>
        {options.map((actor) => (
          <option key={actor.actorId} value={actor.actorId}>
            {actor.displayName}
          </option>
        ))}
      </Select>
      <Button variant="outline" size="sm" onClick={onAdd} disabled={!value}>
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
