import { createHash, randomUUID } from "node:crypto";
import type { DbClient, SqlDatabase } from "./db.js";
import { InProcessEventBus, type EventBus } from "./event-bus.js";
import {
  NotFoundError,
  PermissionError,
  ValidationError,
  type ActorType,
  type AuditRow,
  type DomainEvent,
  type EventType,
  type MessagePart,
  type MessagePartType,
  type MessageRecord,
  type PermissionRequestStatus,
  type Principal,
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
  "message.redacted",
  "membership.updated",
  "cursor.updated",
  "grant.created",
  "grant.revoked",
  "permission_request.created",
  "permission_request.resolved",
  "privacy_policy.updated",
  "artifact.registered",
  "knowledge.promoted",
  "audit.logged",
  "client.registered",
] as const;
const EVENT_TYPE_SET: ReadonlySet<EventType> = new Set(EVENT_TYPES);

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

export function stableJson(input: unknown): string {
  if (input === null || input === undefined) return JSON.stringify(input ?? null);
  if (typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) {
    return `[${input.map((v) => stableJson(v)).join(",")}]`;
  }
  const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
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
  private readonly now: () => Date;
  private readonly idFn: () => string;

  constructor(public readonly db: SqlDatabase, opts: MessageLayerOptions = {}) {
    this.bus = opts.bus ?? new InProcessEventBus();
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
       LIMIT 1`,
      [principal.orgId, principal.actorId, capability, resourceType, resourceId, this.ts()],
    );
    return Boolean(row);
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
      return [created, membership];
    });
    for (const e of events) this.bus.publish(e);
    return channelId;
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
      return [event];
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

    if (!(await this.hasGrant(principal, "message:append", streamType, input.streamId))) {
      if (input.autoRequestOnDeny) {
        const requestId = await this.createPermissionRequest(principal, "message:append", streamType, input.streamId);
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
      return {
        result: { messageId, streamSeq, idempotent: false } as AppendMessageSuccess,
        events: [event],
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
    const allowed =
      row.actor_id === principal.actorId ||
      principal.scopes.includes("message:redact") ||
      (await this.hasGrant(principal, "message:redact", streamType, row.stream_id));
    if (!allowed) {
      throw new PermissionError("missing message:redact", {
        capability: "message:redact",
        resourceType: streamType,
        resourceId: row.stream_id,
      });
    }

    const event = await this.db.tx(async (tx) => {
      const redactedAt = this.ts();
      await this.txQuery(
        tx,
        "UPDATE messages SET redacted=1, redacted_at=?, redacted_by_actor_id=?, redaction_reason=? WHERE id=?",
        [redactedAt, principal.actorId, reason, messageId],
      );
      await this.txQuery(tx, "DELETE FROM message_parts WHERE message_id=?", [messageId]);
      return this.emit(tx, {
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
    });
    this.bus.publish(event);
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
  ): Promise<string> {
    await this.assertOrgActor(principal);
    if (!principal.scopes.includes("grant:create") && !(await this.hasGrant(principal, "grant:create", "org", principal.orgId))) {
      throw new PermissionError("missing grant:create", { capability: "grant:create", resourceType: "org", resourceId: principal.orgId });
    }
    if (!actorId || !resourceType || !capability) throw new ValidationError("actorId, resourceType, capability required");
    const grantId = this.id();
    const event = await this.db.tx(async (tx) => {
      await this.txQuery(
        tx,
        "INSERT INTO grants(id,org_id,actor_id,resource_type,resource_id,capability,expires_at,constraints_json,active,created_by_actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)",
        [
          grantId,
          principal.orgId,
          actorId,
          resourceType,
          resourceId,
          capability,
          expiresAt,
          stableJson(constraints),
          principal.actorId,
          this.ts(),
        ],
      );
      return this.emit(tx, {
        orgId: principal.orgId,
        eventType: "grant.created",
        payload: { orgId: principal.orgId, grantId, actorId, resourceType, resourceId, capability, createdByActorId: principal.actorId },
      });
    });
    this.bus.publish(event);
    return grantId;
  }

  async revokeGrant(principal: Principal, grantId: string): Promise<void> {
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
      await this.txQuery(tx, "UPDATE grants SET active=0 WHERE id=? AND org_id=?", [grantId, principal.orgId]);
      return this.emit(tx, {
        orgId: principal.orgId,
        eventType: "grant.revoked",
        payload: { orgId: principal.orgId, grantId, revokedByActorId: principal.actorId },
      });
    });
    this.bus.publish(event);
  }

  async createPermissionRequest(
    principal: Principal,
    action: string,
    resourceType: string,
    resourceId: string | null,
  ): Promise<string> {
    await this.assertOrgActor(principal);
    if (!action || !resourceType) throw new ValidationError("action and resourceType required");
    const requestId = this.id();
    const event = await this.db.tx(async (tx) => {
      await this.txQuery(
        tx,
        "INSERT INTO permission_requests(id,org_id,actor_id,action,resource_type,resource_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
        [requestId, principal.orgId, principal.actorId, action, resourceType, resourceId, "open", this.ts()],
      );
      return this.emit(tx, {
        orgId: principal.orgId,
        eventType: "permission_request.created",
        payload: { orgId: principal.orgId, requestId, actorId: principal.actorId, action, resourceType, resourceId },
      });
    });
    this.bus.publish(event);
    return requestId;
  }

  async resolvePermissionRequest(
    principal: Principal,
    requestId: string,
    approve: boolean,
    notes = "",
  ): Promise<{ status: PermissionRequestStatus; grantId: string | null }> {
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
    }>(
      "SELECT actor_id,action,resource_type,resource_id,status FROM permission_requests WHERE id=? AND org_id=?",
      [requestId, principal.orgId],
    );
    if (!req) throw new NotFoundError(`permission request not found: ${requestId}`);
    if (req.status !== "open") throw new ValidationError("request not open");

    let grantId: string | null = null;
    if (approve) {
      grantId = await this.createGrant(principal, req.actor_id, req.resource_type, req.resource_id, req.action);
    }
    const status: PermissionRequestStatus = approve ? "approved" : "denied";
    const event = await this.db.tx(async (tx) => {
      await this.txQuery(
        tx,
        "UPDATE permission_requests SET status=?,resolution_notes=?,resolver_actor_id=?,grant_id=?,resolved_at=? WHERE id=?",
        [status, notes, principal.actorId, grantId, this.ts(), requestId],
      );
      return this.emit(tx, {
        orgId: principal.orgId,
        eventType: "permission_request.resolved",
        payload: { orgId: principal.orgId, requestId, status, grantId, resolverActorId: principal.actorId },
      });
    });
    this.bus.publish(event);
    return { status, grantId };
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

  async listOpenPermissionRequests(
    orgId: string,
    actorId?: string,
  ): Promise<Array<{ requestId: string; actorId: string; action: string; resourceType: string; resourceId: string | null; createdAt: string }>> {
    const rows = actorId
      ? await this.query<{ id: string; actor_id: string; action: string; resource_type: string; resource_id: string | null; created_at: string }>(
          "SELECT id,actor_id,action,resource_type,resource_id,created_at FROM permission_requests WHERE org_id=? AND actor_id=? AND status='open' ORDER BY created_at ASC",
          [orgId, actorId],
        )
      : await this.query<{ id: string; actor_id: string; action: string; resource_type: string; resource_id: string | null; created_at: string }>(
          "SELECT id,actor_id,action,resource_type,resource_id,created_at FROM permission_requests WHERE org_id=? AND status='open' ORDER BY created_at ASC",
          [orgId],
        );
    return rows.map((r) => ({
      requestId: r.id,
      actorId: r.actor_id,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      createdAt: r.created_at,
    }));
  }

  // ── audit ────────────────────────────────────────────────────────────────

  async auditRows(orgId: string): Promise<AuditRow[]> {
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
    return rows.map((r) => {
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
