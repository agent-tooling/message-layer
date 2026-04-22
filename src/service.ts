import { createHash, randomUUID } from "node:crypto";
import type { DbClient, SqlDatabase } from "./db.js";
import { InProcessEventBus, type EventBus } from "./event-bus.js";
import {
  DEFAULT_ARTIFACT_MAX_BYTES,
  deriveStorageKey,
  InMemoryStorageAdapter,
  type StorageAdapter,
} from "./storage.js";
import {
  NotFoundError,
  PermissionError,
  ValidationError,
  type ActorType,
  type ApprovalOptions,
  type AuditRow,
  type DomainEvent,
  type EventType,
  type MessagePart,
  type MessagePartType,
  type MessageRecord,
  type PermissionRequestContext,
  type PermissionRequestStatus,
  type Principal,
  type RegisteredCommand,
  type StreamType,
  type Visibility,
  messagePartSchema,
  principalSchema,
  streamTypeSchema,
  visibilitySchema,
} from "./types.js";

type DbRow = Record<string, unknown>;

const EVENT_TYPES = [
  "org.created",
  "channel.created",
  "thread.created",
  "message.appended",
  "mention.recorded",
  "command.invoked",
  "command.registration_requested",
  "command.registered",
  "command.deleted",
  "message.redacted",
  "membership.updated",
  "cursor.updated",
  "grant.created",
  "grant.revoked",
  "permission_request.created",
  "permission_request.resolved",
  "privacy_policy.updated",
  "artifact.registered",
  "artifact.deleted",
  "memory.promoted",
  "audit.logged",
  "client.registered",
] as const;
const EVENT_TYPE_SET: ReadonlySet<EventType> = new Set(EVENT_TYPES);

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

type MentionPartInput = {
  actorId: string;
  label?: string;
  start?: number;
  end?: number;
  partIndex: number;
};

type CommandPartInput = {
  command: string;
  args: Record<string, unknown>;
  invocationId: string | null;
  partIndex: number;
  /** Resolved from registered_commands; null when command is unregistered. */
  commandId: string | null;
  ownerActorId: string | null;
};

/**
 * Build a bounded, non-sensitive preview of an append-message attempt so a
 * human reviewing the resulting permission request can see exactly what
 * the agent wanted to say (or what tool call it was about to make) without
 * approving blindly. AGENTS.md rule 5: permissions are purpose-aware.
 */
function buildAppendRequestContext(
  input: AppendMessageInput,
  parts: MessagePart[],
): PermissionRequestContext {
  const preview = parts.map((p, idx) => {
    if (p.type === "text") {
      const text = typeof p.payload?.text === "string" ? (p.payload.text as string) : "";
      return { index: idx, type: p.type, text: text.length > 500 ? `${text.slice(0, 500)}…` : text };
    }
    // Tool calls / artifact refs / approval_* — surface the type + shallow keys.
    const keys = Object.keys(p.payload ?? {}).slice(0, 8);
    return { index: idx, type: p.type, keys };
  });
  return {
    kind: "message.append",
    streamType: input.streamType,
    streamId: input.streamId,
    idempotencyKey: input.idempotencyKey,
    partCount: parts.length,
    parts: preview,
  };
}

function buildCommandInvokeRequestContext(
  input: AppendMessageInput,
  commands: CommandPartInput[],
): PermissionRequestContext {
  return {
    kind: "command.invoke",
    streamType: input.streamType,
    streamId: input.streamId,
    idempotencyKey: input.idempotencyKey,
    commands: commands.map((command) => ({
      command: command.command,
      invocationId: command.invocationId,
      partIndex: command.partIndex,
      argKeys: Object.keys(command.args).slice(0, 12),
    })),
  };
}

export function stableJson(input: unknown): string {
  if (input === null || input === undefined) return JSON.stringify(input ?? null);
  if (typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) {
    return `[${input.map((v) => stableJson(v)).join(",")}]`;
  }
  const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

/**
 * True when the given actor id appears anywhere in an audit row's payload
 * under a known attribution field. Covers the actor that performed the
 * action (`actorId`, `createdByActorId`, etc.) and the actor the action
 * was performed on (e.g. revoking someone else's grants). The audit UI
 * uses this to render per-actor activity without rebuilding SQL.
 */
function actorAppearsIn(row: AuditRow, target: string): boolean {
  const p = row.payload;
  const candidates = [
    p.actorId,
    p.createdByActorId,
    p.resolverActorId,
    p.revokedByActorId,
    p.redactedByActorId,
    p.promotedByActorId,
    p.deletedByActorId,
    p.addedByActorId,
    p.removedByActorId,
    p.indexedByActorId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c === target) return true;
  }
  return false;
}

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    if (value.length === 0) return {};
    return JSON.parse(value) as Record<string, unknown>;
  }
  return (value ?? {}) as Record<string, unknown>;
}

export interface MessageLayerOptions {
  bus?: EventBus;
  now?: () => Date;
  id?: () => string;
  /**
   * Blob storage for artifacts. Defaults to `InMemoryStorageAdapter` so unit
   * tests and short-lived scripts work with zero configuration. Production
   * deployments pass `LocalFileSystemStorageAdapter` or an external (S3)
   * implementation via `server-runtime.ts`.
   */
  storage?: StorageAdapter;
  /** Hard cap on artifact byte size. Defaults to 10 MB. */
  maxArtifactBytes?: number;
}

export interface RegisterArtifactInput {
  streamId: string;
  streamType: StreamType;
  filename: string;
  contentType: string;
  content: Buffer;
  /** Optional pre-computed sha256 hex. Recomputed and validated server-side. */
  sha256?: string;
}

export interface ArtifactRecord {
  id: string;
  orgId: string;
  streamId: string;
  streamType: StreamType;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  storageKind: string;
  createdByActorId: string;
  createdAt: string;
  deleted: boolean;
  deletedAt: string | null;
  deletedByActorId: string | null;
}

export interface ArtifactContent {
  metadata: ArtifactRecord;
  content: Buffer;
}

export interface AppendMessageInput {
  streamId: string;
  streamType: StreamType;
  parts: MessagePart[];
  idempotencyKey: string;
  /**
   * If the append is denied by capability, automatically open a permission
   * request and return its id instead of throwing. Defaults to `false` for
   * backward compatibility. When enabled, the result is either the normal
   * append result or `{ denied: true, requestId }`.
   */
  autoRequestOnDeny?: boolean;
}

export interface AppendMessageSuccess {
  messageId: string;
  streamSeq: number;
  idempotent: boolean;
  denied?: false;
}

export interface AppendMessageDenied {
  denied: true;
  requestId: string;
  capability: string;
  resourceType: StreamType;
  resourceId: string;
}

export type AppendMessageResult = AppendMessageSuccess | AppendMessageDenied;

export class MessageLayer {
  public readonly bus: EventBus;
  public readonly storage: StorageAdapter;
  public readonly maxArtifactBytes: number;
  private readonly now: () => Date;
  private readonly idFn: () => string;

  constructor(public readonly db: SqlDatabase, opts: MessageLayerOptions = {}) {
    this.bus = opts.bus ?? new InProcessEventBus();
    this.storage = opts.storage ?? new InMemoryStorageAdapter();
    this.maxArtifactBytes = opts.maxArtifactBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
    this.now = opts.now ?? (() => new Date());
    this.idFn = opts.id ?? (() => randomUUID().replace(/-/g, ""));
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private ts(): string {
    return this.now().toISOString();
  }

  private id(): string {
    return this.idFn();
  }

  private async query<T extends DbRow = DbRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.query<T>(sql, params as Array<string | number | null>);
    return result.rows;
  }

  private async queryOne<T extends DbRow = DbRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  private async txQuery<T extends DbRow = DbRow>(tx: DbClient, sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await tx.query<T>(sql, params as Array<string | number | null>);
    return result.rows;
  }

  private async txQueryOne<T extends DbRow = DbRow>(tx: DbClient, sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.txQuery<T>(tx, sql, params);
    return rows[0] ?? null;
  }

  private ensureEventType(eventType: string): asserts eventType is EventType {
    if (!EVENT_TYPE_SET.has(eventType as EventType)) {
      throw new ValidationError(`unsupported event type: ${eventType}`);
    }
  }

  private validatePrincipal(principal: Principal): Principal {
    return principalSchema.parse(principal);
  }

  private async emit(tx: DbClient, input: {
    orgId: string;
    eventType: EventType;
    payload: Record<string, unknown>;
    streamId?: string | null;
    streamSeq?: number | null;
  }): Promise<DomainEvent> {
    this.ensureEventType(input.eventType);
    const createdAt = this.ts();
    const streamId = input.streamId ?? null;
    const streamSeq = input.streamSeq ?? null;
    await this.txQuery(
      tx,
      "INSERT INTO events(id,org_id,stream_id,event_type,payload_json,stream_seq,created_at) VALUES (?,?,?,?,?,?,?)",
      [this.id(), input.orgId, streamId, input.eventType, stableJson(input.payload), streamSeq, createdAt],
    );
    await this.appendAudit(tx, input.orgId, input.eventType, input.payload, createdAt);
    return {
      type: input.eventType,
      payload: input.payload,
      orgId: input.orgId,
      streamId,
      streamSeq,
      createdAt,
    };
  }

  private async appendAudit(tx: DbClient, orgId: string, eventType: EventType, payload: Record<string, unknown>, createdAt: string): Promise<void> {
    const prev = await this.txQueryOne<{ event_hash: string | null }>(
      tx,
      "SELECT event_hash FROM audit_events WHERE org_id=? ORDER BY audit_seq DESC LIMIT 1",
      [orgId],
    );
    const prevHash = prev?.event_hash ?? "";
    const payloadJson = stableJson(payload);
    const eventHash = createHash("sha256")
      .update(`${prevHash}|${eventType}|${payloadJson}|${createdAt}`)
      .digest("hex");
    await this.txQuery(
      tx,
      "INSERT INTO audit_events(id,org_id,event_type,payload_json,prev_hash,event_hash,created_at) VALUES (?,?,?,?,?,?,?)",
      [this.id(), orgId, eventType, payloadJson, prevHash || null, eventHash, createdAt],
    );
  }

  private async assertOrgActor(principal: Principal): Promise<void> {
    this.validatePrincipal(principal);
    const row = await this.queryOne(
      "SELECT 1 FROM actors WHERE id=? AND org_id=?",
      [principal.actorId, principal.orgId],
    );
    if (!row) {
      throw new PermissionError("actor is not in org");
    }
  }

  private async collectCommandParts(
    principal: Principal,
    channelId: string,
    parts: MessagePart[],
  ): Promise<CommandPartInput[]> {
    const out: CommandPartInput[] = [];
    for (const [partIndex, part] of parts.entries()) {
      if (part.type !== "command") continue;
      const rawCommand = typeof part.payload.command === "string" ? part.payload.command.trim() : "";
      if (!rawCommand) {
        throw new ValidationError("command part requires a non-empty payload.command");
      }
      const argsValue = part.payload.args;
      const args =
        argsValue === undefined
          ? {}
          : argsValue && typeof argsValue === "object" && !Array.isArray(argsValue)
            ? (argsValue as Record<string, unknown>)
            : null;
      if (args === null) {
        throw new ValidationError("command part payload.args must be a JSON object when present");
      }
      const invocationIdRaw = part.payload.invocationId;
      const invocationId =
        typeof invocationIdRaw === "string" && invocationIdRaw.trim().length > 0
          ? invocationIdRaw.trim()
          : null;

      // Resolve against registered commands. Long form is "ownerName:cmdName".
      let commandId: string | null = null;
      let ownerActorId: string | null = null;
      const colonIdx = rawCommand.indexOf(":");
      if (colonIdx > 0) {
        // Long form — resolve by owner display_name + command name.
        const ownerName = rawCommand.slice(0, colonIdx).trim();
        const cmdName = rawCommand.slice(colonIdx + 1).trim();
        if (!ownerName || !cmdName) {
          throw new ValidationError(`invalid long-form command syntax: ${rawCommand}`);
        }
        const ownerRow = await this.queryOne<{ id: string }>(
          "SELECT id FROM actors WHERE org_id=? AND display_name=? LIMIT 1",
          [principal.orgId, ownerName],
        );
        if (ownerRow) {
          // Prefer channel-scoped over org-scoped.
          const cmdRow = await this.queryOne<{ id: string; owner_actor_id: string }>(
            `SELECT id, owner_actor_id FROM registered_commands
              WHERE org_id=? AND owner_actor_id=? AND name=? AND status='active'
              ORDER BY CASE WHEN channel_id=? THEN 0 ELSE 1 END ASC
              LIMIT 1`,
            [principal.orgId, ownerRow.id, cmdName, channelId],
          );
          if (cmdRow) {
            commandId = cmdRow.id;
            ownerActorId = cmdRow.owner_actor_id;
          }
        }
      } else {
        // Short form — look up active registrations in channel scope first, then org.
        const cmdRows = await this.query<{ id: string; owner_actor_id: string; channel_id: string | null }>(
          `SELECT id, owner_actor_id, channel_id FROM registered_commands
            WHERE org_id=? AND name=? AND status='active'
              AND (channel_id=? OR channel_id IS NULL)`,
          [principal.orgId, rawCommand, channelId],
        );
        // Prefer channel-scoped; if multiple at the same scope → ambiguous.
        const channelScoped = cmdRows.filter((r) => r.channel_id !== null);
        const orgScoped = cmdRows.filter((r) => r.channel_id === null);
        const candidates = channelScoped.length > 0 ? channelScoped : orgScoped;
        if (candidates.length > 1) {
          const ownerIds = candidates.map((r) => r.owner_actor_id);
          const ownerRows = await this.query<{ id: string; display_name: string }>(
            `SELECT id, display_name FROM actors WHERE id IN (${ownerIds.map(() => "?").join(",")})`,
            ownerIds,
          );
          const names = ownerRows.map((r) => `${r.display_name}:${rawCommand}`).join(", ");
          throw new ValidationError(
            `ambiguous command '${rawCommand}'; use long form — e.g. ${names}`,
          );
        }
        if (candidates.length === 1) {
          commandId = candidates[0].id;
          ownerActorId = candidates[0].owner_actor_id;
        }
      }

      out.push({ command: rawCommand, args, invocationId, partIndex, commandId, ownerActorId });
    }
    return out;
  }

  private async collectMentionParts(
    principal: Principal,
    resolved: { channelId: string; visibility: Visibility },
    parts: MessagePart[],
  ): Promise<MentionPartInput[]> {
    const out: MentionPartInput[] = [];
    for (const [partIndex, part] of parts.entries()) {
      if (part.type !== "mention") continue;
      const actorId = typeof part.payload.actorId === "string" ? part.payload.actorId.trim() : "";
      if (!actorId) {
        throw new ValidationError("mention part requires a non-empty payload.actorId");
      }
      const actor = await this.queryOne<{ id: string; org_id: string }>(
        "SELECT id,org_id FROM actors WHERE id=?",
        [actorId],
      );
      if (!actor || actor.org_id !== principal.orgId) {
        throw new ValidationError(`mentioned actor is not in principal org: ${actorId}`);
      }
      if (resolved.visibility === "private") {
        const visibleToMentioned = await this.isChannelMember(
          principal.orgId,
          actorId,
          resolved.channelId,
        );
        if (!visibleToMentioned) {
          throw new ValidationError(
            `cannot mention actor without private stream access: ${actorId}`,
          );
        }
      }
      const start =
        typeof part.payload.start === "number" && Number.isInteger(part.payload.start)
          ? Number(part.payload.start)
          : undefined;
      const end =
        typeof part.payload.end === "number" && Number.isInteger(part.payload.end)
          ? Number(part.payload.end)
          : undefined;
      if (start !== undefined && start < 0) {
        throw new ValidationError("mention part payload.start must be >= 0");
      }
      if (end !== undefined && end < 0) {
        throw new ValidationError("mention part payload.end must be >= 0");
      }
      if (start !== undefined && end !== undefined && end < start) {
        throw new ValidationError("mention part payload.end must be >= payload.start");
      }
      const label =
        typeof part.payload.label === "string" && part.payload.label.length > 0
          ? part.payload.label
          : undefined;
      out.push({ actorId, label, start, end, partIndex });
    }
    return out;
  }

  private async validateAppendParts(
    principal: Principal,
    input: AppendMessageInput,
    parts: MessagePart[],
  ): Promise<{
    mentions: MentionPartInput[];
    commands: CommandPartInput[];
  }> {
    const streamType = streamTypeSchema.parse(input.streamType);
    const resolved = await this.resolveStreamChannel(input.streamId, streamType);
    if (!resolved) {
      throw new NotFoundError(`${streamType} not found: ${input.streamId}`);
    }
    if (resolved.orgId !== principal.orgId) {
      throw new PermissionError("stream not in principal org");
    }
    const mentions = await this.collectMentionParts(principal, resolved, parts);
    const commands = await this.collectCommandParts(principal, resolved.channelId, parts);
    return { mentions, commands };
  }

  /**
   * Non-consuming capability check. Returns true when the principal either
   * carries the capability as a scope (infinite use, never consumed) or
   * has a live grant for it. A grant is considered live when it is
   * `active`, not yet expired, and either has no `max_uses` cap or has
   * at least one remaining use.
   *
   * Callers that are about to *perform* an action (append a message,
   * create a channel, upload an artifact) should use
   * {@link consumeGrantInTx} inside the surrounding DB transaction
   * instead of this read-only check, so that "approve once" grants
   * burn exactly one use per successful action — even under concurrent
   * calls from the same agent.
   */
  private async hasGrant(
    principal: Principal,
    capability: string,
    resourceType: string,
    resourceId: string | null,
  ): Promise<boolean> {
    if (principal.scopes.includes(capability)) return true;
    const row = await this.queryOne(
      `SELECT 1 FROM grants
       WHERE org_id=? AND actor_id=? AND capability=? AND resource_type=? AND active=1
         AND (resource_id IS NULL OR resource_id=?)
         AND (expires_at IS NULL OR expires_at>?)
         AND (max_uses IS NULL OR uses_count < max_uses)
       LIMIT 1`,
      [principal.orgId, principal.actorId, capability, resourceType, resourceId, this.ts()],
    );
    return Boolean(row);
  }

  /**
   * Atomically consume one "use" of a matching grant inside the caller's
   * transaction. Returns `{ consumed: true, grantId }` when a scope or a
   * live grant backed the call, `{ consumed: false }` otherwise.
   *
   * Scopes never consume — they represent principal-carried capabilities
   * (admin login, service account) that aren't rate-limited.
   *
   * The SQL is written as a single `UPDATE ... WHERE id = (SELECT ...)
   * RETURNING id` so concurrent callers cannot both consume the same
   * single-use grant. When `max_uses` is reached the row's `uses_count`
   * hits `max_uses` and the next select filters it out.
   */
  private async consumeGrantInTx(
    tx: DbClient,
    principal: Principal,
    capability: string,
    resourceType: string,
    resourceId: string | null,
  ): Promise<{ consumed: boolean; grantId: string | null; viaScope: boolean; events: DomainEvent[] }> {
    if (principal.scopes.includes(capability)) {
      return { consumed: true, grantId: null, viaScope: true, events: [] };
    }
    const now = this.ts();
    const updated = await this.txQuery<{ id: string; max_uses: number | null; uses_count: number }>(
      tx,
      `UPDATE grants
         SET uses_count = uses_count + 1
       WHERE id = (
         SELECT id FROM grants
          WHERE org_id=? AND actor_id=? AND capability=? AND resource_type=? AND active=1
            AND (resource_id IS NULL OR resource_id=?)
            AND (expires_at IS NULL OR expires_at>?)
            AND (max_uses IS NULL OR uses_count < max_uses)
          ORDER BY created_at ASC
          LIMIT 1
       )
       RETURNING id, max_uses, uses_count`,
      [principal.orgId, principal.actorId, capability, resourceType, resourceId, now],
    );
    const row = updated[0];
    if (!row) return { consumed: false, grantId: null, viaScope: false, events: [] };

    const events: DomainEvent[] = [];
    // When the last use has been consumed, flip `active=0` so read paths
    // and the `/v1/grants/check` endpoint reflect reality without having
    // to re-derive it from counters. The emitted `grant.revoked` event is
    // returned to the caller so it can be published on the shared bus
    // alongside whatever action event triggered this consumption — a
    // plugin sees "message.appended" and "grant.revoked(autoRevoked=true)"
    // in the same logical step.
    if (row.max_uses !== null && Number(row.uses_count) >= Number(row.max_uses)) {
      await this.txQuery(
        tx,
        "UPDATE grants SET active=0, revoked_at=?, revocation_reason=? WHERE id=?",
        [now, "max_uses exhausted", row.id],
      );
      events.push(
        await this.emit(tx, {
          orgId: principal.orgId,
          eventType: "grant.revoked",
          payload: {
            orgId: principal.orgId,
            grantId: row.id,
            reason: "max_uses exhausted",
            autoRevoked: true,
          },
        }),
      );
    }
    return { consumed: true, grantId: row.id, viaScope: false, events };
  }

  private async nextSeqTx(tx: DbClient, streamId: string): Promise<number> {
    const row = await this.txQueryOne<{ next_seq: number }>(tx, "SELECT next_seq FROM stream_counters WHERE stream_id=?", [streamId]);
    if (!row) {
      await this.txQuery(tx, "INSERT INTO stream_counters(stream_id,next_seq) VALUES (?,?)", [streamId, 2]);
      return 1;
    }
    const seq = Number(row.next_seq);
    await this.txQuery(tx, "UPDATE stream_counters SET next_seq=? WHERE stream_id=?", [seq + 1, streamId]);
    return seq;
  }

  // ── privacy & membership ─────────────────────────────────────────────────

  private async loadChannel(channelId: string): Promise<
    | { id: string; orgId: string; visibility: Visibility; createdByActorId: string }
    | null
  > {
    const row = await this.queryOne<{ id: string; org_id: string; visibility: string; created_by_actor_id: string }>(
      "SELECT id,org_id,visibility,created_by_actor_id FROM channels WHERE id=?",
      [channelId],
    );
    if (!row) return null;
    return {
      id: row.id,
      orgId: row.org_id,
      visibility: visibilitySchema.parse(row.visibility),
      createdByActorId: row.created_by_actor_id,
    };
  }

  private async loadThread(threadId: string): Promise<
    | { id: string; orgId: string; channelId: string; visibility: Visibility; parentMessageId: string; createdByActorId: string }
    | null
  > {
    const row = await this.queryOne<{
      id: string;
      org_id: string;
      channel_id: string;
      visibility: string;
      parent_message_id: string;
      created_by_actor_id: string;
    }>(
      "SELECT id,org_id,channel_id,visibility,parent_message_id,created_by_actor_id FROM threads WHERE id=?",
      [threadId],
    );
    if (!row) return null;
    return {
      id: row.id,
      orgId: row.org_id,
      channelId: row.channel_id,
      visibility: visibilitySchema.parse(row.visibility),
      parentMessageId: row.parent_message_id,
      createdByActorId: row.created_by_actor_id,
    };
  }

  private async isChannelMember(orgId: string, actorId: string, channelId: string): Promise<boolean> {
    const row = await this.queryOne(
      "SELECT 1 FROM memberships WHERE org_id=? AND actor_id=? AND channel_id=? LIMIT 1",
      [orgId, actorId, channelId],
    );
    return Boolean(row);
  }

  /**
   * Returns the channel id a stream resolves to (for threads), or null if the
   * stream does not exist.
   */
  private async resolveStreamChannel(streamId: string, streamType: StreamType): Promise<{ orgId: string; channelId: string; visibility: Visibility } | null> {
    if (streamType === "channel") {
      const channel = await this.loadChannel(streamId);
      if (!channel) return null;
      return { orgId: channel.orgId, channelId: channel.id, visibility: channel.visibility };
    }
    const thread = await this.loadThread(streamId);
    if (!thread) return null;
    return { orgId: thread.orgId, channelId: thread.channelId, visibility: thread.visibility };
  }

  private async assertStreamReadable(principal: Principal, streamId: string, streamType: StreamType): Promise<void> {
    const resolved = await this.resolveStreamChannel(streamId, streamType);
    if (!resolved) {
      throw new NotFoundError(`${streamType} not found: ${streamId}`);
    }
    if (resolved.orgId !== principal.orgId) {
      throw new PermissionError("stream not in principal org");
    }
    if (resolved.visibility === "public") return;
    // private channels/threads require channel membership
    const isMember = await this.isChannelMember(principal.orgId, principal.actorId, resolved.channelId);
    if (!isMember) {
      throw new PermissionError("stream is private and principal is not a member of the owning channel");
    }
  }

  /**
   * Public privacy check delegated to by plugins. Plugins that derive data
   * from messages (memory, knowledge, search) call this on their read paths
   * to guarantee the AGENTS.md rule that derived data is never more visible
   * than its source unless explicitly promoted.
   */
  async assertCanReadStream(principal: Principal, streamId: string, streamType?: StreamType): Promise<void> {
    const resolved = streamType ?? (await this.inferStreamType(streamId));
    await this.assertOrgActor(principal);
    await this.assertStreamReadable(principal, streamId, resolved);
  }

  /**
   * Resolve the org + visibility of a stream without leaking information to
   * principals that cannot see it. Used by plugins that need to snapshot
   * source scope when recording derived data.
   */
  async describeStream(
    principal: Principal,
    streamId: string,
    streamType?: StreamType,
  ): Promise<{ orgId: string; streamType: StreamType; visibility: Visibility; channelId: string }> {
    const resolved = streamType ?? (await this.inferStreamType(streamId));
    await this.assertCanReadStream(principal, streamId, resolved);
    const info = await this.resolveStreamChannel(streamId, resolved);
    if (!info) throw new NotFoundError(`${resolved} not found: ${streamId}`);
    return {
      orgId: info.orgId,
      streamType: resolved,
      visibility: info.visibility,
      channelId: info.channelId,
    };
  }

  // ── orgs / actors ────────────────────────────────────────────────────────

  async createOrg(name: string): Promise<string> {
    if (!name || typeof name !== "string") throw new ValidationError("name is required");
    const orgId = this.id();
    const event = await this.db.tx(async (tx) => {
      await this.txQuery(tx, "INSERT INTO organizations(id,name,created_at) VALUES (?,?,?)", [orgId, name, this.ts()]);
      return this.emit(tx, { orgId, eventType: "org.created", payload: { orgId, name } });
    });
    this.bus.publish(event);
    return orgId;
  }

  async createActor(orgId: string, actorType: ActorType, displayName: string): Promise<string> {
    if (!orgId) throw new ValidationError("orgId is required");
    if (!["human", "agent", "app"].includes(actorType)) throw new ValidationError("invalid actorType");
    if (!displayName) throw new ValidationError("displayName is required");

    const orgRow = await this.queryOne("SELECT 1 FROM organizations WHERE id=?", [orgId]);
    if (!orgRow) throw new NotFoundError(`org not found: ${orgId}`);

    const actorId = this.id();
    const events = await this.db.tx(async (tx) => {
      await this.txQuery(tx, "INSERT INTO actors(id,org_id,type,display_name,created_at) VALUES (?,?,?,?,?)", [
        actorId,
        orgId,
        actorType,
        displayName,
        this.ts(),
      ]);
      await this.txQuery(
        tx,
        "INSERT INTO memberships(id,org_id,actor_id,channel_id,role,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)",
        [this.id(), orgId, actorId, null, "member", "{}", this.ts()],
      );
      const event = await this.emit(tx, {
        orgId,
        eventType: "membership.updated",
        payload: { orgId, actorId, role: "member", scope: "org" },
      });
      return [event];
    });
    for (const e of events) this.bus.publish(e);
    return actorId;
  }

  // ── channels / threads ───────────────────────────────────────────────────

  async createChannel(principal: Principal, name: string, visibility: Visibility = "private"): Promise<string> {
    await this.assertOrgActor(principal);
    visibility = visibilitySchema.parse(visibility);
    if (!name) throw new ValidationError("name is required");
    if (!(await this.hasGrant(principal, "channel:create", "org", principal.orgId))) {
      throw new PermissionError("missing channel:create", { capability: "channel:create", resourceType: "org", resourceId: principal.orgId });
    }
    const channelId = this.id();
    const events = await this.db.tx(async (tx) => {
      const consume = await this.consumeGrantInTx(tx, principal, "channel:create", "org", principal.orgId);
      if (!consume.consumed) {
        throw new PermissionError("missing channel:create", { capability: "channel:create", resourceType: "org", resourceId: principal.orgId });
      }
      const extra = consume.events;
      await this.txQuery(tx, "INSERT INTO channels(id,org_id,name,visibility,created_by_actor_id,created_at) VALUES (?,?,?,?,?,?)", [
        channelId,
        principal.orgId,
        name,
        visibility,
        principal.actorId,
        this.ts(),
      ]);
      await this.txQuery(
        tx,
        "INSERT INTO memberships(id,org_id,actor_id,channel_id,role,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)",
        [this.id(), principal.orgId, principal.actorId, channelId, "owner", "{}", this.ts()],
      );
      const created = await this.emit(tx, {
        orgId: principal.orgId,
        streamId: channelId,
        eventType: "channel.created",
        payload: { orgId: principal.orgId, channelId, name, visibility, createdByActorId: principal.actorId },
      });
      const membership = await this.emit(tx, {
        orgId: principal.orgId,
        streamId: channelId,
        eventType: "membership.updated",
        payload: { orgId: principal.orgId, actorId: principal.actorId, role: "owner", scope: "channel", channelId },
      });
      return [...extra, created, membership];
    });
    for (const e of events) this.bus.publish(e);
    return channelId;
  }

  async deleteChannel(principal: Principal, channelId: string): Promise<void> {
    await this.assertOrgActor(principal);
    const channel = await this.loadChannel(channelId);
    if (!channel) throw new NotFoundError(`channel not found: ${channelId}`);
    if (channel.orgId !== principal.orgId) throw new PermissionError("channel not in principal org");
    const allowed =
      principal.scopes.includes("channel:admin") ||
      channel.createdByActorId === principal.actorId ||
      (await this.hasGrant(principal, "channel:admin", "channel", channelId));
    if (!allowed) {
      throw new PermissionError("missing channel:admin", {
        capability: "channel:admin",
        resourceType: "channel",
        resourceId: channelId,
      });
    }

    const events = await this.db.tx(async (tx) => {
      const threadRows = await this.txQuery<{ id: string }>(
        tx,
        "SELECT id FROM threads WHERE org_id=? AND channel_id=?",
        [principal.orgId, channelId],
      );
      const threadIds = threadRows.map((row) => row.id);
      const streamIds = [channelId, ...threadIds];

      if (streamIds.length > 0) {
        const placeholders = streamIds.map(() => "?").join(",");
        const streamArgs: unknown[] = [principal.orgId, ...streamIds];

        await this.txQuery(
          tx,
          `DELETE FROM message_parts WHERE message_id IN (
             SELECT id FROM messages WHERE org_id=? AND stream_id IN (${placeholders})
           )`,
          streamArgs,
        );
        await this.txQuery(
          tx,
          `DELETE FROM messages WHERE org_id=? AND stream_id IN (${placeholders})`,
          streamArgs,
        );
        await this.txQuery(
          tx,
          `DELETE FROM events WHERE org_id=? AND stream_id IN (${placeholders})`,
          streamArgs,
        );
        await this.txQuery(
          tx,
          `DELETE FROM stream_counters WHERE stream_id IN (${streamIds.map(() => "?").join(",")})`,
          streamIds,
        );
        await this.txQuery(
          tx,
          `UPDATE artifacts
             SET deleted=1, deleted_at=?, deleted_by_actor_id=?
           WHERE org_id=? AND stream_id IN (${placeholders}) AND deleted=0`,
          [this.ts(), principal.actorId, principal.orgId, ...streamIds],
        );
      }

      await this.txQuery(
        tx,
        "DELETE FROM memberships WHERE org_id=? AND channel_id=?",
        [principal.orgId, channelId],
      );
      await this.txQuery(
        tx,
        "UPDATE registered_commands SET status='disabled' WHERE org_id=? AND channel_id=?",
        [principal.orgId, channelId],
      );
      await this.txQuery(
        tx,
        "DELETE FROM threads WHERE org_id=? AND channel_id=?",
        [principal.orgId, channelId],
      );
      await this.txQuery(
        tx,
        "DELETE FROM channels WHERE org_id=? AND id=?",
        [principal.orgId, channelId],
      );

      return [
        await this.emit(tx, {
          orgId: principal.orgId,
          eventType: "audit.logged",
          payload: {
            kind: "channel.deleted",
            orgId: principal.orgId,
            channelId,
            deletedByActorId: principal.actorId,
            threadCount: threadIds.length,
          },
        }),
      ];
    });
    for (const event of events) this.bus.publish(event);
  }

  async addChannelMember(
    principal: Principal,
    channelId: string,
    actorId: string,
    role: string = "member",
  ): Promise<void> {
    await this.assertOrgActor(principal);
    const channel = await this.loadChannel(channelId);
    if (!channel) throw new NotFoundError(`channel not found: ${channelId}`);
    if (channel.orgId !== principal.orgId) throw new PermissionError("channel not in principal org");
    const allowed =
      principal.scopes.includes("channel:admin") ||
      channel.createdByActorId === principal.actorId ||
      (await this.hasGrant(principal, "channel:admin", "channel", channelId));
    if (!allowed) {
      throw new PermissionError("missing channel:admin", { capability: "channel:admin", resourceType: "channel", resourceId: channelId });
    }
    const actor = await this.queryOne<{ org_id: string }>("SELECT org_id FROM actors WHERE id=?", [actorId]);
    if (!actor) throw new NotFoundError(`actor not found: ${actorId}`);
    if (actor.org_id !== principal.orgId) throw new ValidationError("actor is not in principal org");

    const event = await this.db.tx(async (tx) => {
      await this.txQuery(
        tx,
        `INSERT INTO memberships(id,org_id,actor_id,channel_id,role,metadata_json,created_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (org_id, actor_id, channel_id)
         DO UPDATE SET role=EXCLUDED.role`,
        [this.id(), principal.orgId, actorId, channelId, role, "{}", this.ts()],
      );
      return this.emit(tx, {
        orgId: principal.orgId,
        streamId: channelId,
        eventType: "membership.updated",
        payload: { orgId: principal.orgId, actorId, role, scope: "channel", channelId, addedByActorId: principal.actorId },
      });
    });
    this.bus.publish(event);
  }

  async removeChannelMember(principal: Principal, channelId: string, actorId: string): Promise<void> {
    await this.assertOrgActor(principal);
    const channel = await this.loadChannel(channelId);
    if (!channel) throw new NotFoundError(`channel not found: ${channelId}`);
    const allowed =
      principal.scopes.includes("channel:admin") ||
      channel.createdByActorId === principal.actorId ||
      principal.actorId === actorId ||
      (await this.hasGrant(principal, "channel:admin", "channel", channelId));
    if (!allowed) {
      throw new PermissionError("missing channel:admin", { capability: "channel:admin", resourceType: "channel", resourceId: channelId });
    }
    const event = await this.db.tx(async (tx) => {
      await this.txQuery(
        tx,
        "DELETE FROM memberships WHERE org_id=? AND actor_id=? AND channel_id=?",
        [principal.orgId, actorId, channelId],
      );
      return this.emit(tx, {
        orgId: principal.orgId,
        streamId: channelId,
        eventType: "membership.updated",
        payload: { orgId: principal.orgId, actorId, role: null, scope: "channel", channelId, removedByActorId: principal.actorId },
      });
    });
    this.bus.publish(event);
  }

  async listChannelMembers(
    principal: Principal,
    channelId: string,
  ): Promise<Array<{ actorId: string; role: string; createdAt: string }>> {
    await this.assertStreamReadable(principal, channelId, "channel");
    const rows = await this.query<{ actor_id: string; role: string; created_at: string }>(
      `SELECT actor_id, role, created_at FROM memberships
       WHERE org_id=? AND channel_id=? ORDER BY created_at ASC`,
      [principal.orgId, channelId],
    );
    return rows.map((r) => ({ actorId: r.actor_id, role: r.role, createdAt: r.created_at }));
  }

  async createThread(
    principal: Principal,
    channelId: string,
    parentMessageId: string,
    visibility: Visibility = "private",
  ): Promise<string> {
    await this.assertOrgActor(principal);
    visibility = visibilitySchema.parse(visibility);
    const channel = await this.loadChannel(channelId);
    if (!channel) throw new NotFoundError(`channel not found: ${channelId}`);
    if (channel.orgId !== principal.orgId) throw new PermissionError("channel not in principal org");

    const parent = await this.queryOne<{ id: string; stream_id: string }>(
      "SELECT id, stream_id FROM messages WHERE id=? AND org_id=?",
      [parentMessageId, principal.orgId],
    );
    if (!parent) throw new NotFoundError(`parentMessageId not found: ${parentMessageId}`);
    if (parent.stream_id !== channelId) {
      throw new ValidationError("parentMessageId does not belong to channelId");
    }

    if (!(await this.hasGrant(principal, "thread:create", "channel", channelId))) {
      throw new PermissionError("missing thread:create", { capability: "thread:create", resourceType: "channel", resourceId: channelId });
    }
    const threadId = this.id();
    const events = await this.db.tx(async (tx) => {
      const consume = await this.consumeGrantInTx(tx, principal, "thread:create", "channel", channelId);
      if (!consume.consumed) {
        throw new PermissionError("missing thread:create", { capability: "thread:create", resourceType: "channel", resourceId: channelId });
      }
      await this.txQuery(
        tx,
        "INSERT INTO threads(id,org_id,channel_id,parent_message_id,visibility,created_by_actor_id,created_at) VALUES (?,?,?,?,?,?,?)",
        [threadId, principal.orgId, channelId, parentMessageId, visibility, principal.actorId, this.ts()],
      );
      const event = await this.emit(tx, {
        orgId: principal.orgId,
        streamId: threadId,
        eventType: "thread.created",
        payload: { orgId: principal.orgId, threadId, channelId, parentMessageId, visibility, createdByActorId: principal.actorId },
      });
      return [...consume.events, event];
    });
    for (const e of events) this.bus.publish(e);
    return threadId;
  }

  async listChannels(
    principal: Principal,
  ): Promise<Array<{ id: string; name: string; visibility: Visibility; createdByActorId: string; createdAt: string }>> {
    await this.assertOrgActor(principal);
    const rows = await this.query<{
      id: string;
      name: string;
      visibility: string;
      created_by_actor_id: string;
      created_at: string;
    }>(
      `SELECT c.id,c.name,c.visibility,c.created_by_actor_id,c.created_at FROM channels c
       WHERE c.org_id=? AND (
         c.visibility='public'
         OR EXISTS(SELECT 1 FROM memberships m WHERE m.channel_id=c.id AND m.actor_id=?)
       )
       ORDER BY c.created_at ASC`,
      [principal.orgId, principal.actorId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      visibility: visibilitySchema.parse(r.visibility),
      createdByActorId: r.created_by_actor_id,
      createdAt: r.created_at,
    }));
  }

  async listThreads(
    principal: Principal,
    channelId: string,
  ): Promise<Array<{ id: string; parentMessageId: string; visibility: Visibility; createdByActorId: string; createdAt: string }>> {
    await this.assertStreamReadable(principal, channelId, "channel");
    const rows = await this.query<{
      id: string;
      parent_message_id: string;
      visibility: string;
      created_by_actor_id: string;
      created_at: string;
    }>(
      `SELECT t.id,t.parent_message_id,t.visibility,t.created_by_actor_id,t.created_at
       FROM threads t
       WHERE t.org_id=? AND t.channel_id=?
       ORDER BY t.created_at ASC`,
      [principal.orgId, channelId],
    );
    return rows.map((r) => ({
      id: r.id,
      parentMessageId: r.parent_message_id,
      visibility: visibilitySchema.parse(r.visibility),
      createdByActorId: r.created_by_actor_id,
      createdAt: r.created_at,
    }));
  }

  async listMembers(
    principal: Principal,
  ): Promise<Array<{ actorId: string; actorType: ActorType; displayName: string; role: string; createdAt: string }>> {
    await this.assertOrgActor(principal);
    const rows = await this.query<{
      actor_id: string;
      actor_type: string;
      display_name: string;
      role: string;
      created_at: string;
    }>(
      `SELECT m.actor_id,a.type AS actor_type,a.display_name,m.role,m.created_at
       FROM memberships m
       INNER JOIN actors a ON a.id=m.actor_id
       WHERE m.org_id=? AND m.channel_id IS NULL
       ORDER BY m.created_at ASC`,
      [principal.orgId],
    );
    return rows.map((r) => ({
      actorId: r.actor_id,
      actorType: r.actor_type as ActorType,
      displayName: r.display_name,
      role: r.role,
      createdAt: r.created_at,
    }));
  }

  async listActorSummaries(
    principal: Principal,
  ): Promise<Array<{ actorId: string; actorType: ActorType; displayName: string; createdAt: string }>> {
    await this.assertOrgActor(principal);
    const rows = await this.query<{ id: string; type: string; display_name: string; created_at: string }>(
      "SELECT id,type,display_name,created_at FROM actors WHERE org_id=? ORDER BY created_at ASC",
      [principal.orgId],
    );
    return rows.map((r) => ({
      actorId: r.id,
      actorType: r.type as ActorType,
      displayName: r.display_name,
      createdAt: r.created_at,
    }));
  }

  // ── messages ─────────────────────────────────────────────────────────────

  async appendMessage(principal: Principal, input: AppendMessageInput): Promise<AppendMessageResult> {
    await this.assertOrgActor(principal);
    const streamType = streamTypeSchema.parse(input.streamType);
    if (!input.streamId) throw new ValidationError("streamId is required");
    if (!input.idempotencyKey) throw new ValidationError("idempotencyKey is required");
    const parts = (input.parts ?? []).map((p) => messagePartSchema.parse(p));
    if (parts.length === 0) throw new ValidationError("parts must be non-empty");

    // Privacy: must be in org + stream must be readable (membership for private).
    await this.assertStreamReadable(principal, input.streamId, streamType);
    const { mentions, commands } = await this.validateAppendParts(principal, input, parts);

    // Fast read-only check to decide between "deny" and "open permission
    // request". The actual grant consumption happens inside the transaction
    // below so single-use grants burn atomically with the insert.
    if (!(await this.hasGrant(principal, "message:append", streamType, input.streamId))) {
      if (input.autoRequestOnDeny) {
        const requestId = await this.createPermissionRequest(
          principal,
          "message:append",
          streamType,
          input.streamId,
          buildAppendRequestContext(input, parts),
        );
        return {
          denied: true,
          requestId,
          capability: "message:append",
          resourceType: streamType,
          resourceId: input.streamId,
        };
      }
      throw new PermissionError("missing message:append", {
        capability: "message:append",
        resourceType: streamType,
        resourceId: input.streamId,
      });
    }
    if (commands.length > 0 && !(await this.hasGrant(principal, "command:invoke", streamType, input.streamId))) {
      if (input.autoRequestOnDeny) {
        const requestId = await this.createPermissionRequest(
          principal,
          "command:invoke",
          streamType,
          input.streamId,
          buildCommandInvokeRequestContext(input, commands),
        );
        return {
          denied: true,
          requestId,
          capability: "command:invoke",
          resourceType: streamType,
          resourceId: input.streamId,
        };
      }
      throw new PermissionError("missing command:invoke", {
        capability: "command:invoke",
        resourceType: streamType,
        resourceId: input.streamId,
      });
    }

    const resultAndEvents = await this.db.tx(async (tx) => {
      const existing = await this.txQueryOne<{ id: string; stream_seq: number }>(
        tx,
        "SELECT id,stream_seq FROM messages WHERE org_id=? AND stream_id=? AND actor_id=? AND idempotency_key=?",
        [principal.orgId, input.streamId, principal.actorId, input.idempotencyKey],
      );
      if (existing) {
        return {
          result: { messageId: existing.id, streamSeq: Number(existing.stream_seq), idempotent: true } as AppendMessageSuccess,
          events: [] as DomainEvent[],
        };
      }

      // Atomically consume one use of a matching grant (no-op when the
      // principal carries the capability as a scope).
      const consume = await this.consumeGrantInTx(tx, principal, "message:append", streamType, input.streamId);
      if (!consume.consumed) {
        throw new PermissionError("missing message:append", {
          capability: "message:append",
          resourceType: streamType,
          resourceId: input.streamId,
        });
      }
      const extraEvents = [...consume.events];
      if (commands.length > 0) {
        const commandConsume = await this.consumeGrantInTx(
          tx,
          principal,
          "command:invoke",
          streamType,
          input.streamId,
        );
        if (!commandConsume.consumed) {
          throw new PermissionError("missing command:invoke", {
            capability: "command:invoke",
            resourceType: streamType,
            resourceId: input.streamId,
          });
        }
        extraEvents.push(...commandConsume.events);
      }

      const messageId = this.id();
      const streamSeq = await this.nextSeqTx(tx, input.streamId);
      const createdAt = this.ts();
      await this.txQuery(
        tx,
        "INSERT INTO messages(id,org_id,stream_id,stream_type,actor_id,stream_seq,idempotency_key,created_at,redacted) VALUES (?,?,?,?,?,?,?,?,0)",
        [messageId, principal.orgId, input.streamId, streamType, principal.actorId, streamSeq, input.idempotencyKey, createdAt],
      );
      for (const [idx, part] of parts.entries()) {
        await this.txQuery(
          tx,
          "INSERT INTO message_parts(id,message_id,part_index,part_type,payload_json) VALUES (?,?,?,?,?)",
          [this.id(), messageId, idx, part.type, stableJson(part.payload)],
        );
      }
      const event = await this.emit(tx, {
        orgId: principal.orgId,
        streamId: input.streamId,
        streamSeq,
        eventType: "message.appended",
        payload: {
          orgId: principal.orgId,
          streamId: input.streamId,
          streamType,
          messageId,
          streamSeq,
          actorId: principal.actorId,
          partCount: parts.length,
          createdAt,
        },
      });
      const mentionEvents: DomainEvent[] = [];
      for (const mention of mentions) {
        mentionEvents.push(
          await this.emit(tx, {
            orgId: principal.orgId,
            streamId: input.streamId,
            streamSeq,
            eventType: "mention.recorded",
            payload: {
              orgId: principal.orgId,
              streamId: input.streamId,
              streamType,
              messageId,
              streamSeq,
              mentionedActorId: mention.actorId,
              partIndex: mention.partIndex,
              label: mention.label ?? null,
              start: mention.start ?? null,
              end: mention.end ?? null,
              actorId: principal.actorId,
            },
          }),
        );
      }
      const commandEvents: DomainEvent[] = [];
      for (const command of commands) {
        commandEvents.push(
          await this.emit(tx, {
            orgId: principal.orgId,
            streamId: input.streamId,
            streamSeq,
            eventType: "command.invoked",
            payload: {
              orgId: principal.orgId,
              streamId: input.streamId,
              streamType,
              messageId,
              streamSeq,
              command: command.command,
              commandId: command.commandId,
              ownerActorId: command.ownerActorId,
              invocationId: command.invocationId,
              partIndex: command.partIndex,
              argKeys: Object.keys(command.args),
              actorId: principal.actorId,
            },
          }),
        );
      }
      return {
        result: { messageId, streamSeq, idempotent: false } as AppendMessageSuccess,
        events: [event, ...mentionEvents, ...commandEvents, ...extraEvents],
      };
    });

    for (const e of resultAndEvents.events) this.bus.publish(e);
    return resultAndEvents.result;
  }

  async redactMessage(
    principal: Principal,
    messageId: string,
    reason: string = "",
  ): Promise<void> {
    await this.assertOrgActor(principal);
    const row = await this.queryOne<{
      id: string;
      stream_id: string;
      stream_type: string;
      actor_id: string;
      redacted: number;
    }>(
      "SELECT id,stream_id,stream_type,actor_id,redacted FROM messages WHERE id=? AND org_id=?",
      [messageId, principal.orgId],
    );
    if (!row) throw new NotFoundError(`message not found: ${messageId}`);
    if (Number(row.redacted) === 1) return;

    const streamType = row.stream_type as StreamType;
    const isAuthor = row.actor_id === principal.actorId;
    if (!isAuthor && !(await this.hasGrant(principal, "message:redact", streamType, row.stream_id))) {
      throw new PermissionError("missing message:redact", {
        capability: "message:redact",
        resourceType: streamType,
        resourceId: row.stream_id,
      });
    }

    const events = await this.db.tx(async (tx) => {
      const extra: DomainEvent[] = [];
      if (!isAuthor) {
        const consume = await this.consumeGrantInTx(tx, principal, "message:redact", streamType, row.stream_id);
        if (!consume.consumed) {
          throw new PermissionError("missing message:redact", {
            capability: "message:redact",
            resourceType: streamType,
            resourceId: row.stream_id,
          });
        }
        extra.push(...consume.events);
      }
      const redactedAt = this.ts();
      await this.txQuery(
        tx,
        "UPDATE messages SET redacted=1, redacted_at=?, redacted_by_actor_id=?, redaction_reason=? WHERE id=?",
        [redactedAt, principal.actorId, reason, messageId],
      );
      await this.txQuery(tx, "DELETE FROM message_parts WHERE message_id=?", [messageId]);
      const redacted = await this.emit(tx, {
        orgId: principal.orgId,
        streamId: row.stream_id,
        eventType: "message.redacted",
        payload: {
          orgId: principal.orgId,
          messageId,
          streamId: row.stream_id,
          redactedAt,
          redactedByActorId: principal.actorId,
          reason,
        },
      });
      return [...extra, redacted];
    });
    for (const e of events) this.bus.publish(e);
  }

  async listMessages(
    principal: Principal,
    streamId: string,
    options: { streamType?: StreamType; afterSeq?: number; limit?: number } = {},
  ): Promise<MessageRecord[]> {
    const streamType: StreamType =
      options.streamType ?? (await this.inferStreamType(streamId));
    await this.assertStreamReadable(principal, streamId, streamType);
    const afterSeq = options.afterSeq ?? 0;
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

    const rows = await this.query<{
      id: string;
      stream_seq: number;
      actor_id: string;
      created_at: string;
      redacted: number;
      redacted_at: string | null;
    }>(
      `SELECT id,stream_seq,actor_id,created_at,redacted,redacted_at
       FROM messages WHERE org_id=? AND stream_id=? AND stream_seq>? ORDER BY stream_seq ASC LIMIT ?`,
      [principal.orgId, streamId, afterSeq, limit],
    );
    const out: MessageRecord[] = [];
    for (const row of rows) {
      const isRedacted = Number(row.redacted) === 1;
      const parts = isRedacted
        ? []
        : (await this.query<{ part_index: number; part_type: string; payload_json: unknown }>(
            "SELECT part_index,part_type,payload_json FROM message_parts WHERE message_id=? ORDER BY part_index ASC",
            [row.id],
          )).map((p) => ({
            index: Number(p.part_index),
            type: p.part_type as MessagePartType,
            payload: parseJsonRecord(p.payload_json),
          }));
      out.push({
        id: row.id,
        streamSeq: Number(row.stream_seq),
        actorId: row.actor_id,
        createdAt: row.created_at,
        redacted: isRedacted,
        redactedAt: row.redacted_at ?? null,
        parts,
      });
    }
    return out;
  }

  private async inferStreamType(streamId: string): Promise<StreamType> {
    const channel = await this.queryOne("SELECT 1 FROM channels WHERE id=?", [streamId]);
    if (channel) return "channel";
    const thread = await this.queryOne("SELECT 1 FROM threads WHERE id=?", [streamId]);
    if (thread) return "thread";
    throw new NotFoundError(`stream not found: ${streamId}`);
  }

  async subscribe(
    principal: Principal,
    streamId: string,
    options: { streamType?: StreamType; fromSeq?: number; limit?: number } = {},
  ): Promise<DomainEvent[]> {
    const streamType = options.streamType ?? (await this.inferStreamType(streamId));
    await this.assertStreamReadable(principal, streamId, streamType);
    const fromSeq = options.fromSeq ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 200, 1), MAX_LIST_LIMIT * 2);

    const rows = await this.query<{
      event_type: string;
      payload_json: unknown;
      stream_seq: number | null;
      created_at: string;
    }>(
      `SELECT event_type,payload_json,stream_seq,created_at FROM events
       WHERE org_id=? AND stream_id=? AND COALESCE(stream_seq,0)>?
       ORDER BY COALESCE(stream_seq,0) ASC, created_at ASC
       LIMIT ?`,
      [principal.orgId, streamId, fromSeq, limit],
    );
    return rows.map((row) => {
      this.ensureEventType(row.event_type);
      return {
        type: row.event_type,
        payload: parseJsonRecord(row.payload_json),
        orgId: principal.orgId,
        streamId,
        streamSeq: row.stream_seq === null ? null : Number(row.stream_seq),
        createdAt: row.created_at,
      };
    });
  }

  // ── cursors / clients ────────────────────────────────────────────────────

  async updateCursor(principal: Principal, streamId: string, lastSeenSeq: number, lastAckSeq: number): Promise<void> {
    await this.assertOrgActor(principal);
    if (!Number.isFinite(lastSeenSeq) || lastSeenSeq < 0) throw new ValidationError("lastSeenSeq must be >= 0");
    if (!Number.isFinite(lastAckSeq) || lastAckSeq < 0) throw new ValidationError("lastAckSeq must be >= 0");
    const event = await this.db.tx(async (tx) => {
      await this.txQuery(
        tx,
        `INSERT INTO cursors(id,org_id,actor_id,stream_id,last_seen_seq,last_ack_seq,updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (org_id,actor_id,stream_id)
         DO UPDATE SET last_seen_seq=EXCLUDED.last_seen_seq,last_ack_seq=EXCLUDED.last_ack_seq,updated_at=EXCLUDED.updated_at`,
        [this.id(), principal.orgId, principal.actorId, streamId, lastSeenSeq, lastAckSeq, this.ts()],
      );
      return this.emit(tx, {
        orgId: principal.orgId,
        streamId,
        eventType: "cursor.updated",
        payload: { orgId: principal.orgId, actorId: principal.actorId, streamId, lastSeenSeq, lastAckSeq },
      });
    });
    this.bus.publish(event);
  }

  async getCursor(
    principal: Principal,
    streamId: string,
  ): Promise<{ lastSeenSeq: number; lastAckSeq: number; updatedAt: string } | null> {
    await this.assertOrgActor(principal);
    const row = await this.queryOne<{ last_seen_seq: number; last_ack_seq: number; updated_at: string }>(
      "SELECT last_seen_seq,last_ack_seq,updated_at FROM cursors WHERE org_id=? AND actor_id=? AND stream_id=?",
      [principal.orgId, principal.actorId, streamId],
    );
    if (!row) return null;
    return {
      lastSeenSeq: Number(row.last_seen_seq),
      lastAckSeq: Number(row.last_ack_seq),
      updatedAt: row.updated_at,
    };
  }

  async registerClient(principal: Principal, endpoint: string, metadata: Record<string, unknown> = {}): Promise<string> {
    await this.assertOrgActor(principal);
    if (!endpoint) throw new ValidationError("endpoint is required");
    const clientId = this.id();
    const event = await this.db.tx(async (tx) => {
      await this.txQuery(
        tx,
        "INSERT INTO clients(id,org_id,actor_id,endpoint,metadata_json,created_at) VALUES (?,?,?,?,?,?)",
        [clientId, principal.orgId, principal.actorId, endpoint, stableJson(metadata), this.ts()],
      );
      return this.emit(tx, {
        orgId: principal.orgId,
        eventType: "client.registered",
        payload: { orgId: principal.orgId, clientId, actorId: principal.actorId, endpoint },
      });
    });
    this.bus.publish(event);
    return clientId;
  }

  // ── grants / permission requests ─────────────────────────────────────────

  async createGrant(
    principal: Principal,
    actorId: string,
    resourceType: string,
    resourceId: string | null,
    capability: string,
    expiresAt: string | null = null,
    constraints: Record<string, unknown> = {},
    maxUses: number | null = null,
  ): Promise<string> {
    await this.assertOrgActor(principal);
    if (!principal.scopes.includes("grant:create") && !(await this.hasGrant(principal, "grant:create", "org", principal.orgId))) {
      throw new PermissionError("missing grant:create", { capability: "grant:create", resourceType: "org", resourceId: principal.orgId });
    }
    if (!actorId || !resourceType || !capability) throw new ValidationError("actorId, resourceType, capability required");
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
      throw new ValidationError("maxUses must be a positive integer or null");
    }
    if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) {
      throw new ValidationError("expiresAt must be an ISO-8601 timestamp or null");
    }
    const grantId = this.id();
    const event = await this.db.tx(async (tx) => {
      await this.txQuery(
        tx,
        "INSERT INTO grants(id,org_id,actor_id,resource_type,resource_id,capability,expires_at,constraints_json,max_uses,uses_count,active,created_by_actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,0,1,?,?)",
        [
          grantId,
          principal.orgId,
          actorId,
          resourceType,
          resourceId,
          capability,
          expiresAt,
          stableJson(constraints),
          maxUses,
          principal.actorId,
          this.ts(),
        ],
      );
      return this.emit(tx, {
        orgId: principal.orgId,
        eventType: "grant.created",
        payload: {
          orgId: principal.orgId,
          grantId,
          actorId,
          resourceType,
          resourceId,
          capability,
          expiresAt,
          maxUses,
          createdByActorId: principal.actorId,
        },
      });
    });
    this.bus.publish(event);
    return grantId;
  }

  async revokeGrant(principal: Principal, grantId: string, reason = ""): Promise<void> {
    await this.assertOrgActor(principal);
    if (!principal.scopes.includes("grant:create") && !(await this.hasGrant(principal, "grant:create", "org", principal.orgId))) {
      throw new PermissionError("missing grant:create", { capability: "grant:create", resourceType: "org", resourceId: principal.orgId });
    }
    const existing = await this.queryOne<{ id: string; active: number }>(
      "SELECT id, active FROM grants WHERE id=? AND org_id=?",
      [grantId, principal.orgId],
    );
    if (!existing) throw new NotFoundError(`grant not found: ${grantId}`);

    const event = await this.db.tx(async (tx) => {
      await this.txQuery(
        tx,
        "UPDATE grants SET active=0, revoked_at=?, revoked_by_actor_id=?, revocation_reason=? WHERE id=? AND org_id=?",
        [this.ts(), principal.actorId, reason, grantId, principal.orgId],
      );
      return this.emit(tx, {
        orgId: principal.orgId,
        eventType: "grant.revoked",
        payload: { orgId: principal.orgId, grantId, revokedByActorId: principal.actorId, reason },
      });
    });
    this.bus.publish(event);
  }

  /**
   * "Kick an agent": revoke every live grant held by a single actor in one
   * shot, emitting one `grant.revoked` event per affected grant so plugins
   * (notifications, audit UIs) see each revocation individually. Requires
   * `grant:create` on the org — same capability a resolver needs.
   */
  async revokeAllGrantsForActor(
    principal: Principal,
    actorId: string,
    reason = "",
  ): Promise<{ revokedGrantIds: string[] }> {
    await this.assertOrgActor(principal);
    if (!principal.scopes.includes("grant:create") && !(await this.hasGrant(principal, "grant:create", "org", principal.orgId))) {
      throw new PermissionError("missing grant:create", { capability: "grant:create", resourceType: "org", resourceId: principal.orgId });
    }
    if (!actorId) throw new ValidationError("actorId is required");
    const targetActor = await this.queryOne<{ org_id: string }>("SELECT org_id FROM actors WHERE id=?", [actorId]);
    if (!targetActor) throw new NotFoundError(`actor not found: ${actorId}`);
    if (targetActor.org_id !== principal.orgId) {
      throw new PermissionError("actor is not in principal org");
    }

    const active = await this.query<{ id: string }>(
      "SELECT id FROM grants WHERE org_id=? AND actor_id=? AND active=1",
      [principal.orgId, actorId],
    );
    const ids = active.map((r) => r.id);
    if (ids.length === 0) return { revokedGrantIds: [] };

    const events = await this.db.tx(async (tx) => {
      const out: DomainEvent[] = [];
      const now = this.ts();
      for (const id of ids) {
        await this.txQuery(
          tx,
          "UPDATE grants SET active=0, revoked_at=?, revoked_by_actor_id=?, revocation_reason=? WHERE id=? AND org_id=?",
          [now, principal.actorId, reason, id, principal.orgId],
        );
        out.push(
          await this.emit(tx, {
            orgId: principal.orgId,
            eventType: "grant.revoked",
            payload: {
              orgId: principal.orgId,
              grantId: id,
              actorId,
              revokedByActorId: principal.actorId,
              reason,
              bulk: true,
            },
          }),
        );
      }
      return out;
    });
    for (const e of events) this.bus.publish(e);
    return { revokedGrantIds: ids };
  }

  async createPermissionRequest(
    principal: Principal,
    action: string,
    resourceType: string,
    resourceId: string | null,
    context: PermissionRequestContext = {},
  ): Promise<string> {
    await this.assertOrgActor(principal);
    if (!action || !resourceType) throw new ValidationError("action and resourceType required");
    const requestId = this.id();
    const event = await this.db.tx(async (tx) => {
      await this.txQuery(
        tx,
        "INSERT INTO permission_requests(id,org_id,actor_id,action,resource_type,resource_id,status,request_context_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [requestId, principal.orgId, principal.actorId, action, resourceType, resourceId, "open", stableJson(context), this.ts()],
      );
      return this.emit(tx, {
        orgId: principal.orgId,
        eventType: "permission_request.created",
        payload: {
          orgId: principal.orgId,
          requestId,
          actorId: principal.actorId,
          action,
          resourceType,
          resourceId,
          context,
        },
      });
    });
    this.bus.publish(event);
    return requestId;
  }

  async resolvePermissionRequest(
    principal: Principal,
    requestId: string,
    approve: boolean,
    options: ApprovalOptions = {},
  ): Promise<{ status: PermissionRequestStatus; grantId: string | null; commandId: string | null }> {
    await this.assertOrgActor(principal);
    if (!principal.scopes.includes("grant:create") && !(await this.hasGrant(principal, "grant:create", "org", principal.orgId))) {
      throw new PermissionError("missing grant:create", { capability: "grant:create", resourceType: "org", resourceId: principal.orgId });
    }

    const req = await this.queryOne<{
      actor_id: string;
      action: string;
      resource_type: string;
      resource_id: string | null;
      status: PermissionRequestStatus;
      request_context_json: unknown;
    }>(
      "SELECT actor_id,action,resource_type,resource_id,status,request_context_json FROM permission_requests WHERE id=? AND org_id=?",
      [requestId, principal.orgId],
    );
    if (!req) throw new NotFoundError(`permission request not found: ${requestId}`);
    if (req.status !== "open") throw new ValidationError("request not open");

    const notes = options.notes ?? "";
    const status: PermissionRequestStatus = approve ? "approved" : "denied";

    // Command registration requests are resolved by activating or disabling
    // the pending registered_commands row — no generic grant is created.
    if (req.action === "command:register") {
      const context = parseJsonRecord(req.request_context_json) as PermissionRequestContext;
      const commandId = typeof context.commandId === "string" ? context.commandId : null;
      const events = await this.db.tx(async (tx) => {
        if (commandId) {
          await this.txQuery(
            tx,
            "UPDATE registered_commands SET status=? WHERE id=?",
            [approve ? "active" : "disabled", commandId],
          );
        }
        await this.txQuery(
          tx,
          "UPDATE permission_requests SET status=?,resolution_notes=?,resolver_actor_id=?,resolved_at=? WHERE id=?",
          [status, notes, principal.actorId, this.ts(), requestId],
        );
        const resolvedEvent = await this.emit(tx, {
          orgId: principal.orgId,
          eventType: "permission_request.resolved",
          payload: {
            orgId: principal.orgId,
            requestId,
            status,
            grantId: null,
            commandId,
            resolverActorId: principal.actorId,
          },
        });
        if (approve && commandId) {
          const registeredEvent = await this.emit(tx, {
            orgId: principal.orgId,
            eventType: "command.registered",
            payload: {
              orgId: principal.orgId,
              commandId,
              requestId,
              name: context.name ?? null,
              channelId: context.channelId ?? null,
              ownerActorId: context.ownerActorId ?? null,
              resolverActorId: principal.actorId,
            },
          });
          return [resolvedEvent, registeredEvent];
        }
        return [resolvedEvent];
      });
      for (const e of events) this.bus.publish(e);
      return { status, grantId: null, commandId };
    }

    let grantId: string | null = null;
    if (approve) {
      grantId = await this.createGrant(
        principal,
        req.actor_id,
        req.resource_type,
        req.resource_id,
        req.action,
        options.expiresAt ?? null,
        {},
        options.maxUses ?? null,
      );
    }
    const event = await this.db.tx(async (tx) => {
      await this.txQuery(
        tx,
        "UPDATE permission_requests SET status=?,resolution_notes=?,resolver_actor_id=?,grant_id=?,resolved_at=? WHERE id=?",
        [status, notes, principal.actorId, grantId, this.ts(), requestId],
      );
      return this.emit(tx, {
        orgId: principal.orgId,
        eventType: "permission_request.resolved",
        payload: {
          orgId: principal.orgId,
          requestId,
          status,
          grantId,
          commandId: null,
          expiresAt: options.expiresAt ?? null,
          maxUses: options.maxUses ?? null,
          resolverActorId: principal.actorId,
        },
      });
    });
    this.bus.publish(event);
    return { status, grantId, commandId: null };
  }

  async checkGrant(orgId: string, actorId: string, capability: string): Promise<boolean> {
    const row = await this.queryOne(
      `SELECT 1 FROM grants
       WHERE org_id=? AND actor_id=? AND capability=? AND active=1
         AND (expires_at IS NULL OR expires_at>?)
       LIMIT 1`,
      [orgId, actorId, capability, this.ts()],
    );
    return Boolean(row);
  }

  async listActorEffectiveGrants(
    principal: Principal,
    actorId: string,
  ): Promise<
    Array<{
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
    }>
  > {
    await this.assertOrgActor(principal);
    if (
      !principal.scopes.includes("grant:create") &&
      !(await this.hasGrant(principal, "grant:create", "org", principal.orgId))
    ) {
      throw new PermissionError("missing grant:create", {
        capability: "grant:create",
        resourceType: "org",
        resourceId: principal.orgId,
      });
    }
    if (!actorId) throw new ValidationError("actorId is required");
    const targetActor = await this.queryOne<{ org_id: string }>(
      "SELECT org_id FROM actors WHERE id=?",
      [actorId],
    );
    if (!targetActor) throw new NotFoundError(`actor not found: ${actorId}`);
    if (targetActor.org_id !== principal.orgId) {
      throw new PermissionError("actor is not in principal org");
    }

    const rows = await this.query<{
      id: string;
      actor_id: string;
      resource_type: string;
      resource_id: string | null;
      capability: string;
      expires_at: string | null;
      constraints_json: unknown;
      max_uses: number | null;
      uses_count: number;
      created_at: string;
      created_by_actor_id: string;
    }>(
      `SELECT id,actor_id,resource_type,resource_id,capability,expires_at,constraints_json,max_uses,uses_count,created_at,created_by_actor_id
         FROM grants
        WHERE org_id=? AND actor_id=? AND active=1
          AND (expires_at IS NULL OR expires_at>?)
          AND (max_uses IS NULL OR uses_count < max_uses)
        ORDER BY capability ASC, created_at DESC`,
      [principal.orgId, actorId, this.ts()],
    );
    return rows.map((row) => ({
      grantId: row.id,
      actorId: row.actor_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      capability: row.capability,
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      usesCount: Number(row.uses_count ?? 0),
      remainingUses:
        row.max_uses === null ? null : Math.max(0, Number(row.max_uses) - Number(row.uses_count ?? 0)),
      constraints: parseJsonRecord(row.constraints_json),
      createdAt: row.created_at,
      createdByActorId: row.created_by_actor_id,
    }));
  }

  async listOpenPermissionRequests(
    orgId: string,
    actorId?: string,
  ): Promise<Array<{
    requestId: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string | null;
    context: PermissionRequestContext;
    createdAt: string;
  }>> {
    const rows = actorId
      ? await this.query<{ id: string; actor_id: string; action: string; resource_type: string; resource_id: string | null; request_context_json: unknown; created_at: string }>(
          "SELECT id,actor_id,action,resource_type,resource_id,request_context_json,created_at FROM permission_requests WHERE org_id=? AND actor_id=? AND status='open' ORDER BY created_at ASC",
          [orgId, actorId],
        )
      : await this.query<{ id: string; actor_id: string; action: string; resource_type: string; resource_id: string | null; request_context_json: unknown; created_at: string }>(
          "SELECT id,actor_id,action,resource_type,resource_id,request_context_json,created_at FROM permission_requests WHERE org_id=? AND status='open' ORDER BY created_at ASC",
          [orgId],
        );
    return rows.map((r) => ({
      requestId: r.id,
      actorId: r.actor_id,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      context: parseJsonRecord(r.request_context_json) as PermissionRequestContext,
      createdAt: r.created_at,
    }));
  }

  async getPermissionRequest(
    orgId: string,
    requestId: string,
  ): Promise<{
    requestId: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string | null;
    status: PermissionRequestStatus;
    context: PermissionRequestContext;
    createdAt: string;
    resolvedAt: string | null;
    grantId: string | null;
  } | null> {
    const row = await this.queryOne<{
      id: string;
      actor_id: string;
      action: string;
      resource_type: string;
      resource_id: string | null;
      status: PermissionRequestStatus;
      request_context_json: unknown;
      created_at: string;
      resolved_at: string | null;
      grant_id: string | null;
    }>(
      `SELECT id,actor_id,action,resource_type,resource_id,status,request_context_json,created_at,resolved_at,grant_id
       FROM permission_requests
       WHERE org_id=? AND id=?`,
      [orgId, requestId],
    );
    if (!row) return null;
    return {
      requestId: row.id,
      actorId: row.actor_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      status: row.status,
      context: parseJsonRecord(row.request_context_json) as PermissionRequestContext,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      grantId: row.grant_id,
    };
  }

  // ── artifacts ────────────────────────────────────────────────────────────

  /**
   * Register a new artifact in a stream. Bytes are persisted through the
   * configured `StorageAdapter`; only metadata lands in SQL (AGENTS.md rule
   * #14). Privacy is enforced against the target stream and the caller must
   * hold `artifact:register` on that stream, or already be allowed to append
   * messages to it (`message:append`).
   */
  async registerArtifact(
    principal: Principal,
    input: RegisterArtifactInput,
  ): Promise<ArtifactRecord> {
    await this.assertOrgActor(principal);
    const streamType = streamTypeSchema.parse(input.streamType);
    if (!input.streamId) throw new ValidationError("streamId is required");
    if (!input.filename) throw new ValidationError("filename is required");
    if (!input.contentType) throw new ValidationError("contentType is required");
    if (!Buffer.isBuffer(input.content)) throw new ValidationError("content must be a Buffer");
    if (input.content.byteLength === 0) throw new ValidationError("content must be non-empty");
    if (input.content.byteLength > this.maxArtifactBytes) {
      throw new ValidationError(
        `content exceeds maxArtifactBytes (${input.content.byteLength} > ${this.maxArtifactBytes})`,
      );
    }

    await this.assertStreamReadable(principal, input.streamId, streamType);

    const allowed =
      (await this.hasGrant(principal, "artifact:register", streamType, input.streamId)) ||
      (await this.hasGrant(principal, "message:append", streamType, input.streamId));
    if (!allowed) {
      throw new PermissionError("missing artifact:register", {
        capability: "artifact:register",
        resourceType: streamType,
        resourceId: input.streamId,
      });
    }
    // Actual grant consumption happens inside the metadata tx below, so a
    // single-use artifact:register grant burns atomically with the
    // artifact INSERT.

    const computedSha = createHash("sha256").update(input.content).digest("hex");
    if (input.sha256 && input.sha256.toLowerCase() !== computedSha) {
      throw new ValidationError("sha256 mismatch with provided content");
    }

    const artifactId = this.id();
    const storageKey = deriveStorageKey(principal.orgId, artifactId);
    const createdAt = this.ts();
    const size = input.content.byteLength;

    // Write bytes before committing metadata so a DB failure can't leave a
    // dangling SQL row pointing at missing content. Blob orphans are
    // tolerable (and garbage-collectable); missing blobs are not.
    await this.storage.put(storageKey, input.content, { contentType: input.contentType });

    try {
      const events = await this.db.tx(async (tx) => {
        const first = await this.consumeGrantInTx(tx, principal, "artifact:register", streamType, input.streamId);
        const consume = first.consumed
          ? first
          : await this.consumeGrantInTx(tx, principal, "message:append", streamType, input.streamId);
        if (!consume.consumed) {
          throw new PermissionError("missing artifact:register", {
            capability: "artifact:register",
            resourceType: streamType,
            resourceId: input.streamId,
          });
        }
        const extra = consume.events;
        await this.txQuery(
          tx,
          `INSERT INTO artifacts(
             id,org_id,stream_id,stream_type,storage_kind,storage_key,
             filename,content_type,size,sha256,created_by_actor_id,created_at,deleted
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`,
          [
            artifactId,
            principal.orgId,
            input.streamId,
            streamType,
            this.storage.kind,
            storageKey,
            input.filename,
            input.contentType,
            size,
            computedSha,
            principal.actorId,
            createdAt,
          ],
        );
        const registered = await this.emit(tx, {
          orgId: principal.orgId,
          streamId: input.streamId,
          eventType: "artifact.registered",
          payload: {
            orgId: principal.orgId,
            artifactId,
            streamId: input.streamId,
            streamType,
            filename: input.filename,
            contentType: input.contentType,
            size,
            sha256: computedSha,
            createdByActorId: principal.actorId,
          },
        });
        return [...extra, registered];
      });
      for (const e of events) this.bus.publish(e);
    } catch (error) {
      // Best-effort cleanup of the just-written blob if the metadata insert
      // failed. Swallow adapter errors during cleanup — the original failure
      // is the one the caller needs to see.
      await this.storage.delete(storageKey).catch(() => {});
      throw error;
    }

    return {
      id: artifactId,
      orgId: principal.orgId,
      streamId: input.streamId,
      streamType,
      filename: input.filename,
      contentType: input.contentType,
      size,
      sha256: computedSha,
      storageKind: this.storage.kind,
      createdByActorId: principal.actorId,
      createdAt,
      deleted: false,
      deletedAt: null,
      deletedByActorId: null,
    };
  }

  async getArtifactMetadata(principal: Principal, artifactId: string): Promise<ArtifactRecord> {
    await this.assertOrgActor(principal);
    const row = await this.loadArtifactRow(principal.orgId, artifactId);
    await this.assertStreamReadable(principal, row.streamId, row.streamType);
    return row;
  }

  async downloadArtifact(principal: Principal, artifactId: string): Promise<ArtifactContent> {
    await this.assertOrgActor(principal);
    const row = await this.loadArtifactRow(principal.orgId, artifactId);
    await this.assertStreamReadable(principal, row.streamId, row.streamType);
    if (row.deleted) {
      throw new NotFoundError(`artifact deleted: ${artifactId}`);
    }
    const blob = await this.storage.get(this.artifactStorageKey(row));
    if (!blob) {
      throw new NotFoundError(`artifact content missing: ${artifactId}`);
    }
    return { metadata: row, content: blob.content };
  }

  async listArtifacts(
    principal: Principal,
    streamId: string,
    options: { streamType?: StreamType; includeDeleted?: boolean } = {},
  ): Promise<ArtifactRecord[]> {
    const streamType = options.streamType ?? (await this.inferStreamType(streamId));
    await this.assertStreamReadable(principal, streamId, streamType);
    const includeDeleted = options.includeDeleted === true;
    const rows = await this.query<DbRow>(
      `SELECT id,org_id,stream_id,stream_type,storage_kind,storage_key,filename,content_type,size,sha256,
              created_by_actor_id,created_at,deleted,deleted_at,deleted_by_actor_id
       FROM artifacts WHERE org_id=? AND stream_id=? ${includeDeleted ? "" : "AND deleted=0"}
       ORDER BY created_at ASC`,
      [principal.orgId, streamId],
    );
    return rows.map((r) => this.mapArtifactRow(r));
  }

  async deleteArtifact(principal: Principal, artifactId: string, reason = ""): Promise<void> {
    await this.assertOrgActor(principal);
    const row = await this.loadArtifactRow(principal.orgId, artifactId);
    if (row.deleted) return;
    const allowed =
      row.createdByActorId === principal.actorId ||
      principal.scopes.includes("artifact:admin") ||
      (await this.hasGrant(principal, "artifact:admin", row.streamType, row.streamId));
    if (!allowed) {
      throw new PermissionError("missing artifact:admin", {
        capability: "artifact:admin",
        resourceType: row.streamType,
        resourceId: row.streamId,
      });
    }
    const deletedAt = this.ts();
    const event = await this.db.tx(async (tx) => {
      await this.txQuery(
        tx,
        "UPDATE artifacts SET deleted=1, deleted_at=?, deleted_by_actor_id=? WHERE id=? AND org_id=?",
        [deletedAt, principal.actorId, artifactId, principal.orgId],
      );
      return this.emit(tx, {
        orgId: principal.orgId,
        streamId: row.streamId,
        eventType: "artifact.deleted",
        payload: {
          orgId: principal.orgId,
          artifactId,
          streamId: row.streamId,
          streamType: row.streamType,
          deletedAt,
          deletedByActorId: principal.actorId,
          reason,
        },
      });
    });
    // Bytes go away on hard-delete elsewhere; soft delete keeps them for now
    // so audit + verification stays consistent. Storage GC is a follow-up.
    this.bus.publish(event);
  }

  private async loadArtifactRow(orgId: string, artifactId: string): Promise<ArtifactRecord> {
    const row = await this.queryOne<DbRow>(
      `SELECT id,org_id,stream_id,stream_type,storage_kind,storage_key,filename,content_type,size,sha256,
              created_by_actor_id,created_at,deleted,deleted_at,deleted_by_actor_id
       FROM artifacts WHERE id=? AND org_id=?`,
      [artifactId, orgId],
    );
    if (!row) throw new NotFoundError(`artifact not found: ${artifactId}`);
    return this.mapArtifactRow(row);
  }

  private mapArtifactRow(row: DbRow): ArtifactRecord {
    return {
      id: String(row.id),
      orgId: String(row.org_id),
      streamId: String(row.stream_id),
      streamType: streamTypeSchema.parse(row.stream_type),
      filename: String(row.filename),
      contentType: String(row.content_type),
      size: Number(row.size),
      sha256: String(row.sha256),
      storageKind: String(row.storage_kind),
      createdByActorId: String(row.created_by_actor_id),
      createdAt: String(row.created_at),
      deleted: Number(row.deleted) === 1,
      deletedAt: (row.deleted_at as string | null) ?? null,
      deletedByActorId: (row.deleted_by_actor_id as string | null) ?? null,
    };
  }

  private artifactStorageKey(row: ArtifactRecord): string {
    return deriveStorageKey(row.orgId, row.id);
  }

  // ── memory (plugin hooks) ────────────────────────────────────────────────

  /**
   * Record that a plugin has promoted a derived memory unit beyond the
   * scope of its source. Plugins own their own storage; this hook exists
   * solely so the event lands in the core bus + per-org hash-chained audit
   * log (AGENTS.md rule #12 "core emits events, plugins consume").
   *
   * The caller must already be authorized to read the source stream and
   * must hold `memory:promote` (scope or org-level grant). The actual
   * visibility change happens inside the plugin, driven by the emitted
   * `memory.promoted` event.
   */
  async recordMemoryPromotion(
    principal: Principal,
    input: {
      memoryId: string;
      sourceStreamId: string;
      sourceStreamType: StreamType;
      summary?: string;
    },
  ): Promise<DomainEvent> {
    await this.assertOrgActor(principal);
    if (!input.memoryId) throw new ValidationError("memoryId is required");
    if (!input.sourceStreamId) throw new ValidationError("sourceStreamId is required");
    streamTypeSchema.parse(input.sourceStreamType);

    // The promoter must be able to see the source in the first place; we do
    // not allow someone who can't read a channel to cause its derived data
    // to be reclassified.
    await this.assertStreamReadable(principal, input.sourceStreamId, input.sourceStreamType);

    if (
      !principal.scopes.includes("memory:promote") &&
      !(await this.hasGrant(principal, "memory:promote", "org", principal.orgId))
    ) {
      throw new PermissionError("missing memory:promote", {
        capability: "memory:promote",
        resourceType: "org",
        resourceId: principal.orgId,
      });
    }

    const event = await this.db.tx(async (tx) =>
      this.emit(tx, {
        orgId: principal.orgId,
        streamId: input.sourceStreamId,
        eventType: "memory.promoted",
        payload: {
          orgId: principal.orgId,
          memoryId: input.memoryId,
          sourceStreamId: input.sourceStreamId,
          sourceStreamType: input.sourceStreamType,
          promotedByActorId: principal.actorId,
          summary: input.summary ?? null,
          promotedAt: this.ts(),
        },
      }),
    );
    this.bus.publish(event);
    return event;
  }

  // ── command registry ─────────────────────────────────────────────────────

  /**
   * Register a slash command on behalf of the calling actor (must be agent
   * or app). Creates a `pending` row and auto-opens a `command:register`
   * permission request so an admin can approve or deny. Returns both IDs so
   * the caller can track the request state.
   */
  async registerCommand(
    principal: Principal,
    input: {
      name: string;
      description?: string;
      argsSchema?: Record<string, unknown>;
      channelId?: string | null;
    },
  ): Promise<{ commandId: string; requestId: string }> {
    await this.assertOrgActor(principal);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new ValidationError("name is required");
    if (!/^[a-z0-9_-]+$/i.test(name)) {
      throw new ValidationError("command name may only contain letters, digits, hyphens, and underscores");
    }
    const channelId = input.channelId ?? null;
    if (channelId) {
      const ch = await this.loadChannel(channelId);
      if (!ch) throw new NotFoundError(`channel not found: ${channelId}`);
      if (ch.orgId !== principal.orgId) throw new PermissionError("channel not in principal org");
    }
    const argsSchema = input.argsSchema ?? {};

    // Guard: one active-or-pending registration per owner per name per scope.
    const existing = channelId
      ? await this.queryOne(
          `SELECT id FROM registered_commands
            WHERE org_id=? AND owner_actor_id=? AND name=? AND channel_id=?
              AND status IN ('pending', 'active')
            LIMIT 1`,
          [principal.orgId, principal.actorId, name, channelId],
        )
      : await this.queryOne(
          `SELECT id FROM registered_commands
            WHERE org_id=? AND owner_actor_id=? AND name=? AND channel_id IS NULL
              AND status IN ('pending', 'active')
            LIMIT 1`,
          [principal.orgId, principal.actorId, name],
        );
    if (existing) {
      throw new ValidationError(
        `command '${name}' is already registered (pending or active) by this actor in this scope`,
      );
    }

    const commandId = this.id();
    const requestId = this.id();
    const now = this.ts();
    const context: PermissionRequestContext = {
      kind: "command.register",
      commandId,
      name,
      description: input.description ?? null,
      channelId,
      ownerActorId: principal.actorId,
    };
    const events = await this.db.tx(async (tx) => {
      await this.txQuery(
        tx,
        `INSERT INTO registered_commands(id,org_id,channel_id,name,owner_actor_id,description,args_schema_json,status,permission_request_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          commandId,
          principal.orgId,
          channelId,
          name,
          principal.actorId,
          input.description ?? null,
          stableJson(argsSchema),
          "pending",
          requestId,
          now,
        ],
      );
      await this.txQuery(
        tx,
        `INSERT INTO permission_requests(id,org_id,actor_id,action,resource_type,resource_id,status,request_context_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          requestId,
          principal.orgId,
          principal.actorId,
          "command:register",
          channelId ? "channel" : "org",
          channelId ?? principal.orgId,
          "open",
          stableJson(context),
          now,
        ],
      );
      const requestedEvent = await this.emit(tx, {
        orgId: principal.orgId,
        eventType: "command.registration_requested",
        payload: {
          orgId: principal.orgId,
          commandId,
          requestId,
          name,
          channelId,
          ownerActorId: principal.actorId,
          description: input.description ?? null,
        },
      });
      return [requestedEvent];
    });
    for (const e of events) this.bus.publish(e);
    return { commandId, requestId };
  }

  async listCommands(
    principal: Principal,
    channelId?: string | null,
  ): Promise<RegisteredCommand[]> {
    await this.assertOrgActor(principal);
    const rows = await this.query<{
      id: string;
      org_id: string;
      channel_id: string | null;
      name: string;
      owner_actor_id: string;
      description: string | null;
      args_schema_json: unknown;
      status: string;
      permission_request_id: string | null;
      created_at: string;
    }>(
      channelId
        ? `SELECT id,org_id,channel_id,name,owner_actor_id,description,args_schema_json,status,permission_request_id,created_at
             FROM registered_commands
            WHERE org_id=? AND status='active' AND (channel_id=? OR channel_id IS NULL)
            ORDER BY name ASC`
        : `SELECT id,org_id,channel_id,name,owner_actor_id,description,args_schema_json,status,permission_request_id,created_at
             FROM registered_commands
            WHERE org_id=? AND status='active' AND channel_id IS NULL
            ORDER BY name ASC`,
      channelId ? [principal.orgId, channelId] : [principal.orgId],
    );
    return rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      channelId: r.channel_id,
      name: r.name,
      ownerActorId: r.owner_actor_id,
      description: r.description,
      argsSchema: parseJsonRecord(r.args_schema_json),
      status: r.status as RegisteredCommand["status"],
      permissionRequestId: r.permission_request_id,
      createdAt: r.created_at,
    }));
  }

  async deleteCommand(principal: Principal, commandId: string): Promise<void> {
    await this.assertOrgActor(principal);
    const row = await this.queryOne<{
      id: string;
      org_id: string;
      channel_id: string | null;
      owner_actor_id: string;
      name: string;
    }>(
      "SELECT id,org_id,channel_id,owner_actor_id,name FROM registered_commands WHERE id=?",
      [commandId],
    );
    if (!row) throw new NotFoundError(`command not found: ${commandId}`);
    if (row.org_id !== principal.orgId) throw new PermissionError("command not in principal org");

    const isOwner = row.owner_actor_id === principal.actorId;
    const isAdmin =
      principal.scopes.includes("grant:create") ||
      (await this.hasGrant(principal, "grant:create", "org", principal.orgId)) ||
      (row.channel_id
        ? await this.hasGrant(principal, "channel:admin", "channel", row.channel_id)
        : false);
    if (!isOwner && !isAdmin) {
      throw new PermissionError("must be command owner or admin to delete a command");
    }

    const event = await this.db.tx(async (tx) => {
      await this.txQuery(
        tx,
        "UPDATE registered_commands SET status='disabled' WHERE id=?",
        [commandId],
      );
      return this.emit(tx, {
        orgId: principal.orgId,
        eventType: "command.deleted",
        payload: {
          orgId: principal.orgId,
          commandId,
          name: row.name,
          channelId: row.channel_id,
          ownerActorId: row.owner_actor_id,
          deletedByActorId: principal.actorId,
        },
      });
    });
    this.bus.publish(event);
  }

  // ── audit ────────────────────────────────────────────────────────────────

  async auditRows(orgId: string, options: { actorId?: string; limit?: number } = {}): Promise<AuditRow[]> {
    const rows = await this.query<{
      id: string;
      event_type: string;
      payload_json: unknown;
      prev_hash: string | null;
      event_hash: string;
      created_at: string;
    }>(
      "SELECT id,event_type,payload_json,prev_hash,event_hash,created_at FROM audit_events WHERE org_id=? ORDER BY audit_seq ASC",
      [orgId],
    );
    const all: AuditRow[] = rows.map((r) => {
      this.ensureEventType(r.event_type);
      return {
        id: r.id,
        eventType: r.event_type,
        payload: parseJsonRecord(r.payload_json),
        prevHash: r.prev_hash,
        eventHash: r.event_hash,
        createdAt: r.created_at,
      };
    });
    if (!options.actorId && !options.limit) return all;

    // Filter client-side instead of in SQL so the hash chain stays stable
    // — audit rows are small, and we want verification to keep working
    // against the full chain even when callers are looking at a slice.
    let out = all;
    if (options.actorId) {
      const target = options.actorId;
      out = out.filter((row) => actorAppearsIn(row, target));
    }
    if (options.limit && out.length > options.limit) {
      out = out.slice(-options.limit);
    }
    return out;
  }

  async verifyAuditChain(orgId: string): Promise<{ valid: boolean; firstBadIndex: number | null; total: number }> {
    const rows = await this.auditRows(orgId);
    let prev = "";
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const expected = createHash("sha256")
        .update(`${prev}|${row.eventType}|${stableJson(row.payload)}|${row.createdAt}`)
        .digest("hex");
      if (row.eventHash !== expected) {
        return { valid: false, firstBadIndex: i, total: rows.length };
      }
      prev = row.eventHash;
    }
    return { valid: true, firstBadIndex: null, total: rows.length };
  }
}

export { MessageLayer as MessageLayerService };
// Re-export error classes so consumers can import them from the service entry
// point. The canonical definitions live in `./types.js`.
export { PermissionError, ValidationError, NotFoundError };
