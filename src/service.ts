import { randomUUID, createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import type {
  Principal,
  ActorType,
  MessagePart,
  StreamType,
  MessageRecord,
  PermissionRequestStatus,
  EventType,
} from "./types.js";

const partTypeSchema = z.enum([
  "text",
  "tool_call",
  "tool_result",
  "artifact",
  "approval_request",
  "approval_response",
]);

const messagePartSchema = z.object({
  type: partTypeSchema,
  payload: z.record(z.string(), z.unknown()),
});

const streamTypeSchema = z.enum(["channel", "thread"]);

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

type DbRow = Record<string, unknown>;

const EVENT_TYPES: ReadonlySet<EventType> = new Set([
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
  "org.created",
  "client.registered",
]);

type CreateGrantInput = {
  actorId: string;
  resourceType: string;
  resourceId: string | null;
  capability: string;
  expiresAt?: string | null;
  constraints?: Record<string, unknown>;
};

type ResolvePermissionRequestInput = {
  requestId: string;
  approve: boolean;
  notes?: string;
};

export class MessageLayerService {
  constructor(private readonly db: PGlite) {}

  private now(): string {
    return new Date().toISOString();
  }

  private id(): string {
    return randomUUID().replace(/-/g, "");
  }

  private async query<T = DbRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.query<T>(sql, params);
    return result.rows;
  }

  private async queryOne<T = DbRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  private async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.db.exec("BEGIN");
    try {
      const result = await fn();
      await this.db.exec("COMMIT");
      return result;
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureEventType(eventType: string): asserts eventType is EventType {
    if (!EVENT_TYPES.has(eventType as EventType)) {
      throw new Error(`Unsupported event type: ${eventType}`);
    }
  }

  private async appendAudit(orgId: string, eventType: EventType, payload: Record<string, unknown>): Promise<void> {
    const prev = await this.queryOne<{ event_hash: string | null }>(
      "SELECT event_hash FROM audit_events WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1",
      [orgId],
    );
    const prevHash = prev?.event_hash ?? "";
    const createdAt = this.now();
    const payloadJson = JSON.stringify(payload);
    const payloadForHash = JSON.stringify(payload, Object.keys(payload).sort());
    const eventHash = createHash("sha256")
      .update(`${prevHash}|${eventType}|${payloadForHash}|${createdAt}`)
      .digest("hex");

    await this.query(
      `INSERT INTO audit_events(id, org_id, event_type, payload_json, prev_hash, event_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [this.id(), orgId, eventType, payloadJson, prevHash || null, eventHash, createdAt],
    );
  }

  private async appendEvent(input: {
    orgId: string;
    streamId?: string | null;
    streamSeq?: number | null;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.ensureEventType(input.eventType);
    const createdAt = this.now();
    await this.query(
      `INSERT INTO events(id, org_id, stream_id, event_type, payload_json, stream_seq, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        this.id(),
        input.orgId,
        input.streamId ?? null,
        input.eventType,
        JSON.stringify(input.payload),
        input.streamSeq ?? null,
        createdAt,
      ],
    );
    await this.appendAudit(input.orgId, "audit.logged", {
      sourceEventType: input.eventType,
      streamId: input.streamId ?? null,
      streamSeq: input.streamSeq ?? null,
      createdAt,
    });
    await this.appendAudit(input.orgId, input.eventType, input.payload);
  }

  private async assertOrgActor(principal: Principal): Promise<void> {
    const actor = await this.queryOne(
      "SELECT id FROM actors WHERE id = $1 AND org_id = $2",
      [principal.actorId, principal.orgId],
    );
    if (!actor) {
      throw new PermissionDeniedError("actor is not a member of org");
    }
  }

  private async hasCapability(
    principal: Principal,
    capability: string,
    resourceType: string,
    resourceId: string | null,
  ): Promise<boolean> {
    if (principal.scopes.includes(capability)) {
      return true;
    }
    const row = await this.queryOne(
      `SELECT id
       FROM grants
       WHERE org_id = $1
         AND actor_id = $2
         AND capability = $3
         AND resource_type = $4
         AND active = true
         AND (resource_id IS NULL OR resource_id = $5)
         AND (expires_at IS NULL OR expires_at > $6)
       LIMIT 1`,
      [principal.orgId, principal.actorId, capability, resourceType, resourceId, this.now()],
    );
    return Boolean(row);
  }

  private async nextSeq(streamId: string): Promise<number> {
    const counter = await this.queryOne<{ next_seq: number }>(
      "SELECT next_seq FROM stream_counters WHERE stream_id = $1",
      [streamId],
    );
    if (!counter) {
      await this.query("INSERT INTO stream_counters(stream_id, next_seq) VALUES ($1, $2)", [streamId, 2]);
      return 1;
    }
    await this.query("UPDATE stream_counters SET next_seq = $1 WHERE stream_id = $2", [counter.next_seq + 1, streamId]);
    return counter.next_seq;
  }

  async createOrg(name: string): Promise<string> {
    const orgId = this.id();
    await this.query(
      "INSERT INTO organizations(id, name, created_at) VALUES ($1, $2, $3)",
      [orgId, name, this.now()],
    );
    await this.appendEvent({
      orgId,
      eventType: "org.created",
      payload: { orgId, name },
    });
    return orgId;
  }

  async createActor(orgId: string, actorType: ActorType, displayName: string): Promise<string> {
    const actorId = this.id();
    await this.query(
      "INSERT INTO actors(id, org_id, type, display_name, created_at) VALUES ($1, $2, $3, $4, $5)",
      [actorId, orgId, actorType, displayName, this.now()],
    );
    await this.query(
      `INSERT INTO memberships(id, org_id, actor_id, channel_id, role, metadata_json, created_at)
       VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
      [this.id(), orgId, actorId, "member", "{}", this.now()],
    );
    await this.appendEvent({
      orgId,
      eventType: "membership.updated",
      payload: { orgId, actorId, role: "member", scope: "org" },
    });
    return actorId;
  }

  async createChannel(principal: Principal, name: string, visibility = "private"): Promise<string> {
    await this.assertOrgActor(principal);
    if (!(await this.hasCapability(principal, "channel:create", "org", principal.orgId))) {
      throw new PermissionDeniedError("missing channel:create capability");
    }
    const channelId = this.id();
    await this.query(
      `INSERT INTO channels(id, org_id, name, visibility, created_by_actor_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [channelId, principal.orgId, name, visibility, principal.actorId, this.now()],
    );
    await this.query(
      `INSERT INTO memberships(id, org_id, actor_id, channel_id, role, metadata_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [this.id(), principal.orgId, principal.actorId, channelId, "owner", "{}", this.now()],
    );
    await this.appendEvent({
      orgId: principal.orgId,
      streamId: channelId,
      eventType: "channel.created",
      payload: { orgId: principal.orgId, channelId, name, visibility },
    });
    return channelId;
  }

  async createThread(principal: Principal, channelId: string, parentMessageId: string, visibility = "private"): Promise<string> {
    await this.assertOrgActor(principal);
    if (!(await this.hasCapability(principal, "thread:create", "channel", channelId))) {
      throw new PermissionDeniedError("missing thread:create capability");
    }
    const threadId = this.id();
    await this.query(
      `INSERT INTO threads(id, org_id, channel_id, parent_message_id, visibility, created_by_actor_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [threadId, principal.orgId, channelId, parentMessageId, visibility, principal.actorId, this.now()],
    );
    await this.appendEvent({
      orgId: principal.orgId,
      streamId: threadId,
      eventType: "thread.created",
      payload: { orgId: principal.orgId, threadId, channelId, parentMessageId },
    });
    return threadId;
  }

  async appendMessage(input: {
    principal: Principal;
    streamId: string;
    streamType: StreamType;
    parts: MessagePart[];
    idempotencyKey: string;
  }): Promise<{ messageId: string; streamSeq: number; idempotent: boolean }> {
    const streamType = streamTypeSchema.parse(input.streamType);
    await this.assertOrgActor(input.principal);
    if (!(await this.hasCapability(input.principal, "message:append", streamType, input.streamId))) {
      throw new PermissionDeniedError("missing message:append capability");
    }

    const validatedParts = input.parts.map((part) => messagePartSchema.parse(part));

    return this.transaction(async () => {
      const existing = await this.queryOne<{ id: string; stream_seq: number }>(
        `SELECT id, stream_seq
         FROM messages
         WHERE org_id = $1 AND stream_id = $2 AND actor_id = $3 AND idempotency_key = $4`,
        [input.principal.orgId, input.streamId, input.principal.actorId, input.idempotencyKey],
      );
      if (existing) {
        return {
          messageId: existing.id,
          streamSeq: existing.stream_seq,
          idempotent: true,
        };
      }

      const messageId = this.id();
      const streamSeq = await this.nextSeq(input.streamId);
      const createdAt = this.now();

      await this.query(
        `INSERT INTO messages(id, org_id, stream_id, stream_type, actor_id, stream_seq, idempotency_key, created_at, redacted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)`,
        [
          messageId,
          input.principal.orgId,
          input.streamId,
          streamType,
          input.principal.actorId,
          streamSeq,
          input.idempotencyKey,
          createdAt,
        ],
      );

      for (const [index, part] of validatedParts.entries()) {
        await this.query(
          `INSERT INTO message_parts(id, message_id, part_index, part_type, payload_json)
           VALUES ($1, $2, $3, $4, $5)`,
          [this.id(), messageId, index, part.type, JSON.stringify(part.payload)],
        );
      }

      await this.appendEvent({
        orgId: input.principal.orgId,
        streamId: input.streamId,
        streamSeq,
        eventType: "message.appended",
        payload: {
          orgId: input.principal.orgId,
          streamId: input.streamId,
          streamType,
          messageId,
          streamSeq,
          actorId: input.principal.actorId,
          partCount: validatedParts.length,
          createdAt,
        },
      });

      return { messageId, streamSeq, idempotent: false };
    });
  }

  async listMessages(principal: Principal, streamId: string, afterSeq = 0, limit = 50): Promise<MessageRecord[]> {
    await this.assertOrgActor(principal);
    const rows = await this.query<{
      id: string;
      stream_seq: number;
      actor_id: string;
      created_at: string;
    }>(
      `SELECT id, stream_seq, actor_id, created_at
       FROM messages
       WHERE org_id = $1 AND stream_id = $2 AND stream_seq > $3
       ORDER BY stream_seq ASC
       LIMIT $4`,
      [principal.orgId, streamId, afterSeq, limit],
    );

    const messages: MessageRecord[] = [];
    for (const row of rows) {
      const parts = await this.query<{ part_index: number; part_type: string; payload_json: string }>(
        `SELECT part_index, part_type, payload_json
         FROM message_parts
         WHERE message_id = $1
         ORDER BY part_index ASC`,
        [row.id],
      );
      messages.push({
        id: row.id,
        streamSeq: row.stream_seq,
        actorId: row.actor_id,
        createdAt: row.created_at,
        parts: parts.map((part) => ({
          index: part.part_index,
          type: partTypeSchema.parse(part.part_type),
          payload: JSON.parse(part.payload_json) as Record<string, unknown>,
        })),
      });
    }
    return messages;
  }

  async subscribe(principal: Principal, streamId: string, fromSeq = 0): Promise<Array<{
    type: EventType;
    payload: Record<string, unknown>;
    streamSeq: number | null;
    createdAt: string;
  }>> {
    await this.assertOrgActor(principal);
    const rows = await this.query<{
      event_type: string;
      payload_json: string;
      stream_seq: number | null;
      created_at: string;
    }>(
      `SELECT event_type, payload_json, stream_seq, created_at
       FROM events
       WHERE org_id = $1 AND stream_id = $2 AND COALESCE(stream_seq, 0) > $3
       ORDER BY COALESCE(stream_seq, 0) ASC, created_at ASC`,
      [principal.orgId, streamId, fromSeq],
    );

    return rows.map((row) => {
      this.ensureEventType(row.event_type);
      return {
        type: row.event_type,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        streamSeq: row.stream_seq,
        createdAt: row.created_at,
      };
    });
  }

  async updateCursor(principal: Principal, streamId: string, lastSeenSeq: number, lastAckSeq: number): Promise<void> {
    await this.assertOrgActor(principal);
    await this.query(
      `INSERT INTO cursors(id, org_id, actor_id, stream_id, last_seen_seq, last_ack_seq, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, actor_id, stream_id)
       DO UPDATE SET
         last_seen_seq = EXCLUDED.last_seen_seq,
         last_ack_seq = EXCLUDED.last_ack_seq,
         updated_at = EXCLUDED.updated_at`,
      [this.id(), principal.orgId, principal.actorId, streamId, lastSeenSeq, lastAckSeq, this.now()],
    );
    await this.appendEvent({
      orgId: principal.orgId,
      streamId,
      eventType: "cursor.updated",
      payload: {
        orgId: principal.orgId,
        actorId: principal.actorId,
        streamId,
        lastSeenSeq,
        lastAckSeq,
      },
    });
  }

  async createGrant(principal: Principal, input: CreateGrantInput): Promise<string> {
    if (!principal.scopes.includes("grant:create")) {
      throw new PermissionDeniedError("missing grant:create capability");
    }
    const grantId = this.id();
    await this.query(
      `INSERT INTO grants(id, org_id, actor_id, resource_type, resource_id, capability, expires_at, constraints_json, active, created_by_actor_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10)`,
      [
        grantId,
        principal.orgId,
        input.actorId,
        input.resourceType,
        input.resourceId,
        input.capability,
        input.expiresAt ?? null,
        JSON.stringify(input.constraints ?? {}),
        principal.actorId,
        this.now(),
      ],
    );
    await this.appendEvent({
      orgId: principal.orgId,
      eventType: "grant.created",
      payload: {
        orgId: principal.orgId,
        grantId,
        actorId: input.actorId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        capability: input.capability,
      },
    });
    return grantId;
  }

  async revokeGrant(principal: Principal, grantId: string): Promise<void> {
    if (!principal.scopes.includes("grant:create")) {
      throw new PermissionDeniedError("missing grant:create capability");
    }
    await this.query("UPDATE grants SET active = false WHERE id = $1 AND org_id = $2", [grantId, principal.orgId]);
    await this.appendEvent({
      orgId: principal.orgId,
      eventType: "grant.revoked",
      payload: { orgId: principal.orgId, grantId },
    });
  }

  async createPermissionRequest(
    principal: Principal,
    action: string,
    resourceType: string,
    resourceId: string | null,
  ): Promise<string> {
    const requestId = this.id();
    await this.query(
      `INSERT INTO permission_requests(id, org_id, actor_id, action, resource_type, resource_id, status, resolution_notes, resolver_actor_id, grant_id, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, $8, NULL)`,
      [requestId, principal.orgId, principal.actorId, action, resourceType, resourceId, "open", this.now()],
    );
    await this.appendEvent({
      orgId: principal.orgId,
      eventType: "permission_request.created",
      payload: {
        orgId: principal.orgId,
        requestId,
        actorId: principal.actorId,
        action,
        resourceType,
        resourceId,
      },
    });
    return requestId;
  }

  async resolvePermissionRequest(principal: Principal, input: ResolvePermissionRequestInput): Promise<void> {
    if (!principal.scopes.includes("grant:create")) {
      throw new PermissionDeniedError("missing grant:create capability");
    }
    const req = await this.queryOne<{
      actor_id: string;
      action: string;
      resource_type: string;
      resource_id: string | null;
      status: PermissionRequestStatus;
    }>(
      `SELECT actor_id, action, resource_type, resource_id, status
       FROM permission_requests
       WHERE id = $1 AND org_id = $2`,
      [input.requestId, principal.orgId],
    );
    if (!req || req.status !== "open") {
      throw new Error("permission request is not open");
    }

    let status: PermissionRequestStatus = "denied";
    let grantId: string | null = null;
    if (input.approve) {
      grantId = await this.createGrant(principal, {
        actorId: req.actor_id,
        resourceType: req.resource_type,
        resourceId: req.resource_id,
        capability: req.action,
      });
      status = "approved";
    }

    await this.query(
      `UPDATE permission_requests
       SET status = $1,
           resolution_notes = $2,
           resolver_actor_id = $3,
           grant_id = $4,
           resolved_at = $5
       WHERE id = $6`,
      [status, input.notes ?? "", principal.actorId, grantId, this.now(), input.requestId],
    );
    await this.appendEvent({
      orgId: principal.orgId,
      eventType: "permission_request.resolved",
      payload: {
        orgId: principal.orgId,
        requestId: input.requestId,
        status,
        grantId,
      },
    });
  }

  async registerClient(principal: Principal, endpoint: string, metadata: Record<string, unknown> = {}): Promise<string> {
    await this.assertOrgActor(principal);
    const clientId = this.id();
    await this.query(
      `INSERT INTO clients(id, org_id, actor_id, endpoint, metadata_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [clientId, principal.orgId, principal.actorId, endpoint, JSON.stringify(metadata), this.now()],
    );
    await this.appendEvent({
      orgId: principal.orgId,
      eventType: "client.registered",
      payload: { orgId: principal.orgId, clientId, actorId: principal.actorId, endpoint },
    });
    return clientId;
  }
}
