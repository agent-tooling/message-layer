import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SqlDatabase } from "./db.js";
import type {
  ActorType,
  EventType,
  MessagePart,
  MessageRecord,
  PermissionRequestStatus,
  Principal,
  StreamType,
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

type DbRow = Record<string, unknown>;

const EVENT_TYPES: ReadonlySet<EventType> = new Set([
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
]);

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

export function stableJsonRecord(input: Record<string, unknown>): string {
  return JSON.stringify(input, Object.keys(input).sort());
}

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }
  return (value ?? {}) as Record<string, unknown>;
}

export class MessageLayer {
  constructor(public readonly db: SqlDatabase) {}

  private now(): string {
    return new Date().toISOString();
  }

  private id(): string {
    return randomUUID().replace(/-/g, "");
  }

  private async query<T extends DbRow = DbRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.query<T>(sql, params as Array<string | number | null>);
    return result.rows;
  }

  private async queryOne<T extends DbRow = DbRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  private ensureEventType(eventType: string): asserts eventType is EventType {
    if (!EVENT_TYPES.has(eventType as EventType)) {
      throw new Error(`Unsupported event type: ${eventType}`);
    }
  }

  private async appendAudit(orgId: string, eventType: EventType, payload: Record<string, unknown>, createdAt: string): Promise<void> {
    const prev = await this.queryOne<{ event_hash: string | null }>(
      "SELECT event_hash FROM audit_events WHERE org_id=? ORDER BY audit_seq DESC LIMIT 1",
      [orgId],
    );
    const prevHash = prev?.event_hash ?? "";
    const payloadJson = stableJsonRecord(payload);
    const payloadHashView = payloadJson;
    const eventHash = createHash("sha256")
      .update(`${prevHash}|${eventType}|${payloadHashView}|${createdAt}`)
      .digest("hex");
    await this.query(
      "INSERT INTO audit_events(id,org_id,event_type,payload_json,prev_hash,event_hash,created_at) VALUES (?,?,?,?,?,?,?)",
      [this.id(), orgId, eventType, payloadJson, prevHash || null, eventHash, createdAt],
    );
  }

  private async appendEvent(input: {
    orgId: string;
    eventType: EventType;
    payload: Record<string, unknown>;
    streamId?: string | null;
    streamSeq?: number | null;
  }): Promise<void> {
    this.ensureEventType(input.eventType);
    const createdAt = this.now();
    await this.query(
      "INSERT INTO events(id,org_id,stream_id,event_type,payload_json,stream_seq,created_at) VALUES (?,?,?,?,?,?,?)",
      [
        this.id(),
        input.orgId,
        input.streamId ?? null,
        input.eventType,
        stableJsonRecord(input.payload),
        input.streamSeq ?? null,
        createdAt,
      ],
    );
    await this.appendAudit(input.orgId, input.eventType, input.payload, createdAt);
  }

  private async assertOrgActor(principal: Principal): Promise<void> {
    const row = await this.queryOne("SELECT 1 FROM actors WHERE id=? AND org_id=?", [principal.actorId, principal.orgId]);
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
    if (principal.scopes.includes(capability)) {
      return true;
    }
    const row = await this.queryOne(
      `SELECT 1 FROM grants
       WHERE org_id=? AND actor_id=? AND capability=? AND resource_type=? AND active=1
         AND (resource_id IS NULL OR resource_id=?)
         AND (expires_at IS NULL OR expires_at>?)
       LIMIT 1`,
      [principal.orgId, principal.actorId, capability, resourceType, resourceId, this.now()],
    );
    return Boolean(row);
  }

  private async nextSeq(streamId: string): Promise<number> {
    const row = await this.queryOne<{ next_seq: number }>("SELECT next_seq FROM stream_counters WHERE stream_id=?", [streamId]);
    if (!row) {
      await this.query("INSERT INTO stream_counters(stream_id,next_seq) VALUES (?,?)", [streamId, 2]);
      return 1;
    }
    const seq = Number(row.next_seq);
    await this.query("UPDATE stream_counters SET next_seq=? WHERE stream_id=?", [seq + 1, streamId]);
    return seq;
  }

  async createOrg(name: string): Promise<string> {
    const orgId = this.id();
    await this.query("INSERT INTO organizations(id,name,created_at) VALUES (?,?,?)", [orgId, name, this.now()]);
    await this.appendEvent({ orgId, eventType: "org.created", payload: { orgId, name } });
    return orgId;
  }

  async createActor(orgId: string, actorType: ActorType, displayName: string): Promise<string> {
    const actorId = this.id();
    await this.query("INSERT INTO actors(id,org_id,type,display_name,created_at) VALUES (?,?,?,?,?)", [
      actorId,
      orgId,
      actorType,
      displayName,
      this.now(),
    ]);
    await this.query(
      "INSERT INTO memberships(id,org_id,actor_id,channel_id,role,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)",
      [this.id(), orgId, actorId, null, "member", "{}", this.now()],
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
    if (!(await this.hasGrant(principal, "channel:create", "org", principal.orgId))) {
      throw new PermissionError("missing channel:create");
    }
    const channelId = this.id();
    await this.query("INSERT INTO channels(id,org_id,name,visibility,created_by_actor_id,created_at) VALUES (?,?,?,?,?,?)", [
      channelId,
      principal.orgId,
      name,
      visibility,
      principal.actorId,
      this.now(),
    ]);
    await this.query(
      "INSERT INTO memberships(id,org_id,actor_id,channel_id,role,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)",
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
    if (!(await this.hasGrant(principal, "thread:create", "channel", channelId))) {
      throw new PermissionError("missing thread:create");
    }
    const threadId = this.id();
    await this.query(
      "INSERT INTO threads(id,org_id,channel_id,parent_message_id,visibility,created_by_actor_id,created_at) VALUES (?,?,?,?,?,?,?)",
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

  async appendMessage(
    principal: Principal,
    input: {
      streamId: string;
      streamType: StreamType;
      parts: MessagePart[];
      idempotencyKey: string;
    },
  ): Promise<{ messageId: string; streamSeq: number; idempotent: boolean }> {
    const streamType = streamTypeSchema.parse(input.streamType);
    await this.assertOrgActor(principal);
    if (!(await this.hasGrant(principal, "message:append", streamType, input.streamId))) {
      throw new PermissionError("missing message:append");
    }
    const parts = input.parts.map((part) => messagePartSchema.parse(part));
    return this.db.tx(async (tx) => {
      const existing = await tx.query<{ id: string; stream_seq: number }>(
        "SELECT id,stream_seq FROM messages WHERE org_id=? AND stream_id=? AND actor_id=? AND idempotency_key=?",
        [principal.orgId, input.streamId, principal.actorId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        return { messageId: existing.rows[0].id, streamSeq: Number(existing.rows[0].stream_seq), idempotent: true };
      }

      const messageId = this.id();
      const streamSeq = await this.nextSeq(input.streamId);
      await tx.query(
        "INSERT INTO messages(id,org_id,stream_id,stream_type,actor_id,stream_seq,idempotency_key,created_at,redacted) VALUES (?,?,?,?,?,?,?,?,0)",
        [messageId, principal.orgId, input.streamId, streamType, principal.actorId, streamSeq, input.idempotencyKey, this.now()],
      );
      for (const [idx, part] of parts.entries()) {
        await tx.query(
          "INSERT INTO message_parts(id,message_id,part_index,part_type,payload_json) VALUES (?,?,?,?,?)",
          [this.id(), messageId, idx, part.type, stableJsonRecord(part.payload)],
        );
      }
      await this.appendEvent({
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
        },
      });
      return { messageId, streamSeq, idempotent: false };
    });
  }

  async listMessages(principal: Principal, streamId: string, afterSeq = 0, limit = 50): Promise<MessageRecord[]> {
    await this.assertOrgActor(principal);
    const rows = await this.query<{ id: string; stream_seq: number; actor_id: string; created_at: string }>(
      "SELECT id,stream_seq,actor_id,created_at FROM messages WHERE org_id=? AND stream_id=? AND stream_seq>? ORDER BY stream_seq ASC LIMIT ?",
      [principal.orgId, streamId, afterSeq, limit],
    );
    const out: MessageRecord[] = [];
    for (const row of rows) {
      const parts = await this.query<{ part_index: number; part_type: string; payload_json: Record<string, unknown> }>(
        "SELECT part_index,part_type,payload_json FROM message_parts WHERE message_id=? ORDER BY part_index ASC",
        [row.id],
      );
      out.push({
        id: row.id,
        streamSeq: Number(row.stream_seq),
        actorId: row.actor_id,
        createdAt: row.created_at,
        parts: parts.map((p) => ({
          index: Number(p.part_index),
          type: partTypeSchema.parse(p.part_type),
          payload: parseJsonRecord(p.payload_json),
        })),
      });
    }
    return out;
  }

  async subscribe(
    principal: Principal,
    streamId: string,
    fromSeq = 0,
  ): Promise<Array<{ type: EventType; payload: Record<string, unknown>; streamSeq: number | null; createdAt: string }>> {
    await this.assertOrgActor(principal);
    const rows = await this.query<{ event_type: string; payload_json: Record<string, unknown>; stream_seq: number | null; created_at: string }>(
      "SELECT event_type,payload_json,stream_seq,created_at FROM events WHERE org_id=? AND stream_id=? AND COALESCE(stream_seq,0)>? ORDER BY COALESCE(stream_seq,0) ASC, created_at ASC",
      [principal.orgId, streamId, fromSeq],
    );
    return rows.map((row) => {
      this.ensureEventType(row.event_type);
      return {
        type: row.event_type,
        payload: parseJsonRecord(row.payload_json),
        streamSeq: row.stream_seq === null ? null : Number(row.stream_seq),
        createdAt: row.created_at,
      };
    });
  }

  async updateCursor(principal: Principal, streamId: string, lastSeenSeq: number, lastAckSeq: number): Promise<void> {
    await this.assertOrgActor(principal);
    await this.query(
      `INSERT INTO cursors(id,org_id,actor_id,stream_id,last_seen_seq,last_ack_seq,updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (org_id,actor_id,stream_id)
       DO UPDATE SET last_seen_seq=EXCLUDED.last_seen_seq,last_ack_seq=EXCLUDED.last_ack_seq,updated_at=EXCLUDED.updated_at`,
      [this.id(), principal.orgId, principal.actorId, streamId, lastSeenSeq, lastAckSeq, this.now()],
    );
    await this.appendEvent({
      orgId: principal.orgId,
      streamId,
      eventType: "cursor.updated",
      payload: { orgId: principal.orgId, actorId: principal.actorId, streamId, lastSeenSeq, lastAckSeq },
    });
  }

  async createGrant(
    principal: Principal,
    actorId: string,
    resourceType: string,
    resourceId: string | null,
    capability: string,
    expiresAt: string | null = null,
    constraints: Record<string, unknown> = {},
  ): Promise<string> {
    if (!principal.scopes.includes("grant:create")) {
      throw new PermissionError("missing grant:create");
    }
    const grantId = this.id();
    await this.query(
      "INSERT INTO grants(id,org_id,actor_id,resource_type,resource_id,capability,expires_at,constraints_json,active,created_by_actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)",
      [
        grantId,
        principal.orgId,
        actorId,
        resourceType,
        resourceId,
        capability,
        expiresAt,
        stableJsonRecord(constraints),
        principal.actorId,
        this.now(),
      ],
    );
    await this.appendEvent({
      orgId: principal.orgId,
      eventType: "grant.created",
      payload: { orgId: principal.orgId, grantId, actorId, resourceType, resourceId, capability },
    });
    return grantId;
  }

  async revokeGrant(principal: Principal, grantId: string): Promise<void> {
    if (!principal.scopes.includes("grant:create")) {
      throw new PermissionError("missing grant:create");
    }
    await this.query("UPDATE grants SET active=0 WHERE id=? AND org_id=?", [grantId, principal.orgId]);
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
      "INSERT INTO permission_requests(id,org_id,actor_id,action,resource_type,resource_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [requestId, principal.orgId, principal.actorId, action, resourceType, resourceId, "open", this.now()],
    );
    await this.appendEvent({
      orgId: principal.orgId,
      eventType: "permission_request.created",
      payload: { orgId: principal.orgId, requestId, actorId: principal.actorId, action, resourceType, resourceId },
    });
    return requestId;
  }

  async resolvePermissionRequest(principal: Principal, requestId: string, approve: boolean, notes = ""): Promise<void> {
    if (!principal.scopes.includes("grant:create")) {
      throw new PermissionError("missing grant:create");
    }
    const req = await this.queryOne<{
      actor_id: string;
      action: string;
      resource_type: string;
      resource_id: string | null;
      status: PermissionRequestStatus;
    }>("SELECT actor_id,action,resource_type,resource_id,status FROM permission_requests WHERE id=? AND org_id=?", [
      requestId,
      principal.orgId,
    ]);
    if (!req || req.status !== "open") {
      throw new Error("request not open");
    }

    let grantId: string | null = null;
    let status: PermissionRequestStatus = "denied";
    if (approve) {
      grantId = await this.createGrant(principal, req.actor_id, req.resource_type, req.resource_id, req.action);
      status = "approved";
    }
    await this.query(
      "UPDATE permission_requests SET status=?,resolution_notes=?,resolver_actor_id=?,grant_id=?,resolved_at=? WHERE id=?",
      [status, notes, principal.actorId, grantId, this.now(), requestId],
    );
    await this.appendEvent({
      orgId: principal.orgId,
      eventType: "permission_request.resolved",
      payload: { orgId: principal.orgId, requestId, status, grantId },
    });
  }

  async registerClient(principal: Principal, endpoint: string, metadata: Record<string, unknown> = {}): Promise<string> {
    await this.assertOrgActor(principal);
    const clientId = this.id();
    await this.query("INSERT INTO clients(id,org_id,actor_id,endpoint,metadata_json,created_at) VALUES (?,?,?,?,?,?)", [
      clientId,
      principal.orgId,
      principal.actorId,
      endpoint,
      stableJsonRecord(metadata),
      this.now(),
    ]);
    return clientId;
  }

  async auditRows(orgId: string): Promise<Array<{ eventType: string; payload: Record<string, unknown>; eventHash: string; createdAt: string }>> {
    const rows = await this.query<{ event_type: string; payload_json: Record<string, unknown>; event_hash: string; created_at: string }>(
      "SELECT event_type,payload_json,event_hash,created_at FROM audit_events WHERE org_id=? ORDER BY audit_seq ASC",
      [orgId],
    );
    return rows.map((row) => ({
      eventType: row.event_type,
      payload: parseJsonRecord(row.payload_json),
      eventHash: row.event_hash,
      createdAt: row.created_at,
    }));
  }
}

export { MessageLayer as MessageLayerService };
