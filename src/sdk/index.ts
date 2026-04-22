/**
 * message-layer HTTP client SDK.
 *
 * Import path: `message-layer/sdk`
 *
 * @example
 * ```typescript
 * import { MessageLayerClient } from "message-layer/sdk";
 *
 * const client = new MessageLayerClient({
 *   baseUrl: "http://localhost:3000",
 *   principal: { actorId: "actor_123", orgId: "org_456", scopes: [], provider: "myapp" },
 * });
 *
 * const channels = await client.listChannels();
 * ```
 */

import type { AuditRow, MessageRecord, Principal } from "../types.js";

export type { AuditRow, MessageRecord, Principal };

// ── Response types ────────────────────────────────────────────────────────

export type Actor = {
  actorId: string;
  displayName: string;
  actorType: "human" | "agent" | "app";
  createdAt: string;
};

export type OrgMember = {
  actorId: string;
  displayName: string;
  actorType: string;
  role: string;
};

export type Channel = {
  id: string;
  name: string;
  visibility: "public" | "private";
};

export type ChannelMember = {
  actorId: string;
  role: string;
  createdAt: string;
};

export type Thread = {
  id: string;
  parentMessageId: string;
  visibility: "public" | "private";
};

export type GrantRecord = {
  grantId: string;
  actorId: string;
  resourceType: string;
  resourceId: string | null;
  capability: string;
  expiresAt: string | null;
  maxUses: number | null;
  usesCount: number;
  remainingUses: number | null;
  constraints: Record<string, unknown>;
  createdAt: string;
  createdByActorId: string;
};

export type PermissionRequest = {
  requestId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  context: Record<string, unknown>;
  createdAt: string;
};

export type RegisteredCommand = {
  id: string;
  orgId: string;
  channelId: string | null;
  name: string;
  ownerActorId: string;
  description: string | null;
  argsSchema: Record<string, unknown>;
  status: "pending" | "active" | "disabled";
  permissionRequestId: string | null;
  createdAt: string;
};

export type RegisterCommandInput = {
  name: string;
  description?: string;
  argsSchema?: Record<string, unknown>;
  channelId?: string | null;
};

export type ArtifactRecord = {
  id: string;
  orgId: string;
  streamId: string;
  streamType: "channel" | "thread";
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  storageKind: string;
  createdByActorId: string;
  createdAt: string;
  deleted: boolean;
};

export type MemoryUnit = {
  id: string;
  orgId: string;
  sourceStreamId: string;
  sourceStreamType: "channel" | "thread";
  sourceVisibility: "private" | "public";
  canonicalText: string;
  summary: string;
  keywords: string[];
  createdByActorId: string;
  sourceMessageIds: string[];
  promoted: boolean;
  promotedAt: string | null;
  promotedByActorId: string | null;
  promotionSummary: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryHit = {
  unit: MemoryUnit;
  score: number;
  highlights: string[];
};

export type SearchEntityType = "actor" | "channel" | "thread" | "message" | "memory";

export type SearchHit = {
  documentId: string;
  entityType: SearchEntityType;
  entityId: string;
  score: number;
  title: string;
  snippet: string;
  highlights: string[];
  sourceStreamId: string | null;
  sourceStreamType: "channel" | "thread" | null;
  sourceVisibility: "private" | "public" | null;
  promoted: boolean;
  actorType: "human" | "agent" | "app" | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
};

export type SearchSuggestion = {
  entityType: SearchEntityType;
  entityId: string;
  label: string;
  actorType: "human" | "agent" | "app" | null;
};

export type WebhookSubscription = {
  id: string;
  orgId: string;
  actorId: string;
  endpoint: string;
  eventTypes: string[];
  streamId: string | null;
  enabled: boolean;
  createdAt: string;
};

// ── Input types ───────────────────────────────────────────────────────────

export type MessagePart = {
  type:
    | "text"
    | "mention"
    | "command"
    | "tool_call"
    | "tool_result"
    | "artifact"
    | "approval_request"
    | "approval_response"
    | "ui";
  payload: Record<string, unknown>;
};

export type AppendMessageInput = {
  streamId: string;
  streamType: "channel" | "thread";
  parts: MessagePart[];
  idempotencyKey?: string;
  autoRequestOnDeny?: boolean;
};

export type AppendMessageResult =
  | { ok: true; messageId: string; denied?: false }
  | { ok: false; denied: true; permissionRequestId: string; capability: string };

export type CreateGrantInput = {
  actorId: string;
  resourceType: "org" | "channel" | "thread";
  resourceId: string | null;
  capability: string;
  expiresAt?: string | null;
  maxUses?: number | null;
};

export type CreatePermissionRequestInput = {
  action: string;
  resourceType: string;
  resourceId: string | null;
  context?: Record<string, unknown>;
};

export type ResolveOptions = {
  notes?: string;
  expiresAt?: string | null;
  maxUses?: number | null;
};

export type RegisterArtifactInput = {
  streamId: string;
  streamType: "channel" | "thread";
  filename: string;
  contentType: string;
  /** Raw bytes or a base64-encoded string. */
  content: Uint8Array | string;
  sha256?: string;
};

export type WebSocketEvent = {
  type: string;
  payload: Record<string, unknown>;
  streamSeq: number;
  createdAt: string;
};

export type WebSocketHandle = {
  close: () => void;
};

// ── Client ────────────────────────────────────────────────────────────────

export interface MessageLayerClientOptions {
  baseUrl: string;
  /** Authenticated principal. Optional for unauthenticated operations (createOrg, createActor). */
  principal?: Principal;
  /**
   * Shared secret sent on every request to satisfy the `api-key-header-auth`
   * plugin when the server is exposed over the public internet.
   *
   * Matches the server's `MESSAGE_LAYER_API_KEY` env variable.
   * The header name defaults to `x-api-key` and can be overridden with
   * `apiKeyHeader` if the plugin was configured with a custom `headerName`.
   *
   * @example
   * ```typescript
   * const client = new MessageLayerClient({
   *   baseUrl: "https://ml.example.com",
   *   apiKey: process.env.MESSAGE_LAYER_API_KEY,
   *   principal: { ... },
   * });
   * ```
   */
  apiKey?: string;
  /** Header name the server expects the API key in. Defaults to `x-api-key`. */
  apiKeyHeader?: string;
  /** Override the global fetch function (useful for testing or custom transports). */
  fetch?: typeof globalThis.fetch;
}

/**
 * HTTP client for the message-layer API.
 *
 * Create one instance per principal (e.g. per request in a server handler,
 * or per agent session in an agent process).
 */
export class MessageLayerClient {
  private readonly baseUrl: string;
  private readonly principal: Principal | undefined;
  private readonly apiKey: string | undefined;
  private readonly apiKeyHeader: string;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(options: MessageLayerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.principal = options.principal;
    this.apiKey = options.apiKey;
    this.apiKeyHeader = options.apiKeyHeader ?? "x-api-key";
    this._fetch = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      noAuth?: boolean;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (!options.noAuth && this.principal) {
      headers["x-principal"] = JSON.stringify(this.principal);
    }
    if (this.apiKey) {
      headers[this.apiKeyHeader] = this.apiKey;
    }
    const response = await this._fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    let payload: unknown = {};
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!response.ok) {
      throw new Error(
        `message-layer ${response.status}: ${JSON.stringify(payload)}`,
      );
    }
    return payload as T;
  }

  // ── Orgs ────────────────────────────────────────────────────────────────

  /** Create an org. Unauthenticated — no principal required. */
  async createOrg(name: string): Promise<{ orgId: string }> {
    return this.request("/v1/orgs", { method: "POST", body: { name }, noAuth: true });
  }

  // ── Actors ───────────────────────────────────────────────────────────────

  /** Create an actor. Unauthenticated — no principal required. */
  async createActor(input: {
    orgId: string;
    displayName: string;
    actorType: "human" | "agent" | "app";
  }): Promise<{ actorId: string }> {
    return this.request("/v1/actors", { method: "POST", body: input, noAuth: true });
  }

  /** List all actors in the principal's org. */
  async listActors(): Promise<Actor[]> {
    const result = await this.request<{ actors: Actor[] }>("/v1/actors");
    return result.actors;
  }

  /** Revoke every active grant held by an actor. */
  async revokeAllGrantsForActor(
    actorId: string,
    reason?: string,
  ): Promise<{ revokedGrantIds: string[] }> {
    return this.request(`/v1/actors/${actorId}/revoke-grants`, {
      method: "POST",
      body: { reason: reason ?? "" },
    });
  }

  /** List all effective grants held by a specific actor. */
  async listActorGrants(actorId: string): Promise<GrantRecord[]> {
    const result = await this.request<{ grants: GrantRecord[] }>(
      `/v1/actors/${actorId}/grants`,
    );
    return result.grants;
  }

  // ── Members ──────────────────────────────────────────────────────────────

  /** List all org members visible to the principal. */
  async listMembers(): Promise<OrgMember[]> {
    const result = await this.request<{ members: OrgMember[] }>("/v1/members");
    return result.members;
  }

  // ── Channels ─────────────────────────────────────────────────────────────

  /** List channels visible to the principal. */
  async listChannels(): Promise<Channel[]> {
    const result = await this.request<{ channels: Channel[] }>("/v1/channels");
    return result.channels;
  }

  /** Create a channel. */
  async createChannel(
    name: string,
    visibility: "public" | "private" = "public",
  ): Promise<{ channelId: string }> {
    return this.request("/v1/channels", {
      method: "POST",
      body: { name, visibility },
    });
  }

  /** Add a member to a channel. */
  async addChannelMember(
    channelId: string,
    actorId: string,
    role: string = "member",
  ): Promise<void> {
    await this.request(`/v1/channels/${channelId}/members`, {
      method: "POST",
      body: { actorId, role },
    });
  }

  /** Remove a member from a channel. */
  async removeChannelMember(channelId: string, actorId: string): Promise<void> {
    await this.request(`/v1/channels/${channelId}/members/${actorId}`, {
      method: "DELETE",
    });
  }

  /** List members of a channel. */
  async listChannelMembers(channelId: string): Promise<ChannelMember[]> {
    const result = await this.request<{ members: ChannelMember[] }>(
      `/v1/channels/${channelId}/members`,
    );
    return result.members;
  }

  // ── Threads ───────────────────────────────────────────────────────────────

  /** List threads in a channel. */
  async listThreads(channelId: string): Promise<Thread[]> {
    const result = await this.request<{ threads: Thread[] }>(
      `/v1/channels/${channelId}/threads`,
    );
    return result.threads;
  }

  /** Create a thread off a parent message in a channel. */
  async createThread(
    channelId: string,
    parentMessageId: string,
    visibility: "public" | "private" = "public",
  ): Promise<{ threadId: string }> {
    return this.request("/v1/threads", {
      method: "POST",
      body: { channelId, parentMessageId, visibility },
    });
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  /** Append a message to a channel or thread. */
  async appendMessage(input: AppendMessageInput): Promise<AppendMessageResult> {
    return this.request("/v1/messages", {
      method: "POST",
      body: {
        streamId: input.streamId,
        streamType: input.streamType,
        parts: input.parts,
        idempotencyKey: input.idempotencyKey,
        autoRequestOnDeny: input.autoRequestOnDeny,
      },
    });
  }

  /** List messages in a stream (channel or thread). */
  async listMessages(
    streamId: string,
    options?: { afterSeq?: number; limit?: number },
  ): Promise<MessageRecord[]> {
    const params = new URLSearchParams();
    if (options?.afterSeq != null) params.set("afterSeq", String(options.afterSeq));
    if (options?.limit != null) params.set("limit", String(options.limit));
    const qs = params.toString();
    const result = await this.request<{ messages: MessageRecord[] }>(
      `/v1/streams/${streamId}/messages${qs ? `?${qs}` : ""}`,
    );
    return result.messages;
  }

  /** Redact a message. The slot is preserved; content is replaced with a tombstone. */
  async redactMessage(messageId: string, reason?: string): Promise<void> {
    await this.request(`/v1/messages/${messageId}/redact`, {
      method: "POST",
      body: { reason: reason ?? "" },
    });
  }

  // ── Cursors ───────────────────────────────────────────────────────────────

  /** Update the read cursor for a stream. */
  async updateCursor(streamId: string, streamType: "channel" | "thread", lastSeq: number): Promise<void> {
    await this.request("/v1/cursors", {
      method: "POST",
      body: { streamId, streamType, lastSeq },
    });
  }

  /** Get the current read cursor for a stream. */
  async getCursor(streamId: string): Promise<{ streamId: string; lastSeq: number } | null> {
    try {
      return await this.request(`/v1/streams/${streamId}/cursor`);
    } catch {
      return null;
    }
  }

  // ── Grants ────────────────────────────────────────────────────────────────

  /** Create a grant for an actor. */
  async createGrant(input: CreateGrantInput): Promise<{ grantId: string }> {
    return this.request("/v1/grants", { method: "POST", body: input });
  }

  /** Revoke a single grant by ID. */
  async revokeGrant(grantId: string): Promise<void> {
    await this.request(`/v1/grants/${grantId}/revoke`, { method: "POST" });
  }

  /** Check whether a specific actor holds a capability. */
  async checkCapability(actorId: string, capability: string): Promise<boolean> {
    const result = await this.request<{ hasGrant: boolean }>(
      `/v1/grants/check?actorId=${encodeURIComponent(actorId)}&capability=${encodeURIComponent(capability)}`,
    );
    return result.hasGrant;
  }

  // ── Permission requests ────────────────────────────────────────────────────

  /** Open a permission request. */
  async createPermissionRequest(
    input: CreatePermissionRequestInput,
  ): Promise<{ requestId: string }> {
    return this.request("/v1/permission-requests", {
      method: "POST",
      body: {
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        context: input.context ?? {},
      },
    });
  }

  /** List open permission requests (optionally filtered by actor). */
  async listPermissionRequests(actorId?: string): Promise<PermissionRequest[]> {
    const query = actorId ? `?actorId=${encodeURIComponent(actorId)}` : "";
    const result = await this.request<{ requests: PermissionRequest[] }>(
      `/v1/permission-requests${query}`,
    );
    return result.requests;
  }

  /** Approve or deny a permission request. */
  async resolvePermissionRequest(
    requestId: string,
    approve: boolean,
    options?: ResolveOptions,
  ): Promise<void> {
    await this.request(`/v1/permission-requests/${requestId}/resolve`, {
      method: "POST",
      body: {
        approve,
        notes: options?.notes ?? (approve ? "approved" : "denied"),
        expiresAt: options?.expiresAt ?? null,
        maxUses: options?.maxUses ?? null,
      },
    });
  }

  // ── Command registry ──────────────────────────────────────────────────────

  /**
   * Register a slash command. Creates a pending registration and opens an
   * admin approval request. Returns `{ commandId, requestId }`.
   */
  async registerCommand(input: RegisterCommandInput): Promise<{ commandId: string; requestId: string }> {
    return this.request("/v1/commands", {
      method: "POST",
      body: {
        name: input.name,
        description: input.description ?? null,
        argsSchema: input.argsSchema ?? {},
        channelId: input.channelId ?? null,
      },
    });
  }

  /**
   * List active registered commands visible to the caller's org.
   * Pass `channelId` to include channel-scoped commands alongside org-scoped ones.
   */
  async listCommands(channelId?: string | null): Promise<RegisteredCommand[]> {
    const query = channelId ? `?channelId=${encodeURIComponent(channelId)}` : "";
    const result = await this.request<{ commands: RegisteredCommand[] }>(
      `/v1/commands${query}`,
    );
    return result.commands;
  }

  /** Disable a registered command. Must be the command owner or an admin. */
  async deleteCommand(commandId: string): Promise<void> {
    await this.request(`/v1/commands/${commandId}`, { method: "DELETE" });
  }

  // ── Artifacts ─────────────────────────────────────────────────────────────

  /** Register an artifact (upload file bytes to a stream). */
  async registerArtifact(input: RegisterArtifactInput): Promise<ArtifactRecord> {
    const contentBase64 =
      typeof input.content === "string"
        ? input.content
        : Buffer.from(input.content).toString("base64");
    const result = await this.request<{ artifact: ArtifactRecord }>("/v1/artifacts", {
      method: "POST",
      body: {
        streamId: input.streamId,
        streamType: input.streamType,
        filename: input.filename,
        contentType: input.contentType,
        contentBase64,
        sha256: input.sha256,
      },
    });
    return result.artifact;
  }

  /** List artifacts attached to a stream. */
  async listStreamArtifacts(streamId: string): Promise<ArtifactRecord[]> {
    const result = await this.request<{ artifacts: ArtifactRecord[] }>(
      `/v1/streams/${streamId}/artifacts`,
    );
    return result.artifacts;
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  /** Read the per-org audit log. Requires `audit:read` scope. */
  async fetchAuditRows(options?: { actorId?: string; limit?: number }): Promise<AuditRow[]> {
    const params = new URLSearchParams();
    if (options?.actorId) params.set("actorId", options.actorId);
    if (options?.limit) params.set("limit", String(options.limit));
    const qs = params.toString();
    const result = await this.request<{ rows: AuditRow[] }>(
      `/v1/audit/rows${qs ? `?${qs}` : ""}`,
    );
    return result.rows;
  }

  // ── Memory (memory plugin) ────────────────────────────────────────────────

  /**
   * List derived memory units bound to a specific stream. Requires read
   * access to the source stream (privacy delegated to the core service).
   */
  async listMemory(streamId: string): Promise<MemoryUnit[]> {
    const result = await this.request<{ units: MemoryUnit[] }>(
      `/v1/memory?streamId=${encodeURIComponent(streamId)}`,
    );
    return result.units;
  }

  /**
   * List org-wide promoted memory units. Readable by any org member; the
   * source stream's visibility is intentionally bypassed because promotion
   * went through the audited `recordMemoryPromotion` core hook.
   */
  async listPromotedMemory(): Promise<MemoryUnit[]> {
    const result = await this.request<{ units: MemoryUnit[] }>(`/v1/memory?promoted=true`);
    return result.units;
  }

  /**
   * Search derived memory across every stream the principal can read,
   * plus org-wide promoted units. Lexical baseline ranker; results respect
   * source-stream visibility on every read.
   */
  async searchMemory(
    query: string,
    options?: { streamId?: string; limit?: number },
  ): Promise<{ query: string; hits: MemoryHit[] }> {
    const params = new URLSearchParams({ q: query });
    if (options?.streamId) params.set("streamId", options.streamId);
    if (options?.limit != null) params.set("limit", String(options.limit));
    return this.request(`/v1/memory/search?${params.toString()}`);
  }

  /** Fetch a single memory unit by id. */
  async getMemory(memoryId: string): Promise<MemoryUnit> {
    const result = await this.request<{ unit: MemoryUnit }>(`/v1/memory/${memoryId}`);
    return result.unit;
  }

  /** Promote a memory unit org-wide. Requires `memory:promote`. */
  async promoteMemory(memoryId: string, summary?: string): Promise<MemoryUnit> {
    const result = await this.request<{ unit: MemoryUnit }>(
      `/v1/memory/${memoryId}/promote`,
      { method: "POST", body: { summary } },
    );
    return result.unit;
  }

  // ── Search (search plugin) ────────────────────────────────────────────────

  /**
   * Mixed-entity search across actors, channels, threads, messages, and
   * (when the memory plugin is enabled) derived memory units. All results
   * are privacy-filtered against the principal.
   */
  async search(
    query: string,
    options?: {
      entityTypes?: SearchEntityType[];
      streamId?: string;
      actorType?: "human" | "agent" | "app";
      limit?: number;
    },
  ): Promise<{ query: string; hits: SearchHit[] }> {
    const params = new URLSearchParams({ q: query });
    if (options?.entityTypes && options.entityTypes.length > 0) {
      params.set("entityTypes", options.entityTypes.join(","));
    }
    if (options?.streamId) params.set("streamId", options.streamId);
    if (options?.actorType) params.set("actorType", options.actorType);
    if (options?.limit != null) params.set("limit", String(options.limit));
    return this.request(`/v1/search?${params.toString()}`);
  }

  /**
   * Lightweight autosuggest for actors, channels, and threads. Designed
   * for command-bar UX where you want fast, capped results.
   */
  async searchSuggest(
    query: string,
    options?: { limit?: number },
  ): Promise<{ query: string; suggestions: SearchSuggestion[] }> {
    const params = new URLSearchParams({ q: query });
    if (options?.limit != null) params.set("limit", String(options.limit));
    return this.request(`/v1/search/suggest?${params.toString()}`);
  }

  // ── Webhooks (webhooks plugin) ─────────────────────────────────────────────

  /** List webhook subscriptions. Requires the `webhooks` plugin. */
  async listWebhookSubscriptions(): Promise<WebhookSubscription[]> {
    const result = await this.request<{ subscriptions: WebhookSubscription[] }>(
      "/v1/webhooks/subscriptions?includeDisabled=true",
    );
    return result.subscriptions;
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  /**
   * Subscribe to realtime events on a stream over WebSocket.
   *
   * Replays missed events from `fromSeq` first, then pushes live events.
   * Returns a handle with a `close()` method.
   *
   * @example
   * ```typescript
   * const ws = client.subscribe("channel_id", {
   *   fromSeq: 0,
   *   onEvent: (event) => console.log(event),
   *   onError: (err) => console.error(err),
   * });
   * // later...
   * ws.close();
   * ```
   */
  subscribe(
    streamId: string,
    options: {
      streamType?: "channel" | "thread";
      fromSeq?: number;
      onEvent: (event: WebSocketEvent) => void;
      onError?: (error: Error) => void;
      onClose?: () => void;
      WebSocket?: typeof globalThis.WebSocket;
    },
  ): WebSocketHandle {
    const wsUrl = this.baseUrl
      .replace(/^http/, "ws")
      .replace(/^https/, "wss");
    const params = new URLSearchParams();
    if (this.principal) params.set("principal", JSON.stringify(this.principal));
    if (this.apiKey) params.set(this.apiKeyHeader, this.apiKey);
    const qs = params.toString();
    const WS = options.WebSocket ?? globalThis.WebSocket;
    const ws = new WS(`${wsUrl}/v1/ws${qs ? `?${qs}` : ""}`);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          streamId,
          streamType: options.streamType ?? "channel",
          fromSeq: options.fromSeq ?? 0,
        }),
      );
    };

    ws.onmessage = (msg: MessageEvent) => {
      try {
        const data = JSON.parse(String(msg.data)) as {
          type: string;
          event?: WebSocketEvent;
          error?: string;
        };
        if (data.type === "event" && data.event) {
          options.onEvent(data.event);
        } else if (data.type === "error" && options.onError) {
          options.onError(new Error(data.error ?? "WebSocket error"));
        }
      } catch {
        // ignore malformed frames
      }
    };

    ws.onerror = () => {
      options.onError?.(new Error("WebSocket connection error"));
    };

    ws.onclose = () => {
      options.onClose?.();
    };

    return {
      close: () => ws.close(),
    };
  }
}
