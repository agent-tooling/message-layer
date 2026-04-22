import { z } from "zod";

export const actorTypeSchema = z.enum(["human", "agent", "app"]);
export type ActorType = z.infer<typeof actorTypeSchema>;

export const visibilitySchema = z.enum(["private", "public"]);
export type Visibility = z.infer<typeof visibilitySchema>;

export const messagePartTypes = [
  "text",
  "mention",
  "command",
  "tool_call",
  "tool_result",
  "artifact",
  "approval_request",
  "approval_response",
  /**
   * Generative UI part.  The payload carries a `spec` (json-render flat-spec
   * with `root` + `elements`), an optional `catalog` hint (e.g. `"shadcn"`),
   * and an optional `version` string for schema migrations.
   *
   * Agents post `ui` parts; the Next.js client renders them via the shadcn
   * component registry defined in `clients/nextjs/components/genui/`.
   *
   * @example
   * ```json
   * {
   *   "type": "ui",
   *   "payload": {
   *     "catalog": "shadcn",
   *     "spec": {
   *       "root": "card-1",
   *       "elements": {
   *         "card-1": {
   *           "type": "Card",
   *           "props": { "title": "Launch metrics" },
   *           "children": ["metric-1"]
   *         },
   *         "metric-1": {
   *           "type": "Metric",
   *           "props": { "label": "PRs merged", "value": "42" },
   *           "children": []
   *         }
   *       }
   *     }
   *   }
   * }
   * ```
   */
  "ui",
] as const;

export const messagePartTypeSchema = z.enum(messagePartTypes);
export type MessagePartType = z.infer<typeof messagePartTypeSchema>;

export const streamTypeSchema = z.enum(["channel", "thread"]);
export type StreamType = z.infer<typeof streamTypeSchema>;

export const principalSchema = z.object({
  actorId: z.string().min(1),
  orgId: z.string().min(1),
  scopes: z.array(z.string()),
  provider: z.string().min(1),
});
export type Principal = z.infer<typeof principalSchema>;

export const messagePartSchema = z.object({
  type: messagePartTypeSchema,
  payload: z.record(z.unknown()),
});
export type MessagePart = z.infer<typeof messagePartSchema>;

export type MessageRecord = {
  id: string;
  streamSeq: number;
  actorId: string;
  createdAt: string;
  redacted: boolean;
  redactedAt: string | null;
  parts: Array<{
    index: number;
    type: MessagePartType;
    payload: Record<string, unknown>;
  }>;
};

export const permissionRequestStatusSchema = z.enum(["open", "approved", "denied"]);
export type PermissionRequestStatus = z.infer<typeof permissionRequestStatusSchema>;

/**
 * Opaque, capability-specific structured payload attached to a permission
 * request. The agent that opened the request writes whatever args matter
 * for a human to judge the intent (channel name, message text, artifact
 * filename, etc.). The service treats this as a JSON blob and carries it
 * through to the emitted `permission_request.created` event so UIs and
 * policy plugins can render it.
 */
export type PermissionRequestContext = Record<string, unknown>;

/**
 * Resolution options when a human (or policy plugin) approves a request.
 * Inspired by the Better Auth agent-auth spec's
 * `AgentCapabilityGrant { expiresAt, constraints }` shape plus an explicit
 * usage cap so "approve once" is representable without leaking a latent
 * permanent grant.
 */
export type ApprovalOptions = {
  /** ISO-8601 timestamp when the issued grant auto-expires. */
  expiresAt?: string | null;
  /**
   * How many times the grant may be consumed before it auto-deactivates.
   * Omitted / null means unlimited. `1` is the "approve once" case.
   */
  maxUses?: number | null;
  /** Free-form resolver notes (reason, context for the audit log). */
  notes?: string;
};

export const eventTypes = [
  "channel.created",
  "thread.created",
  "message.appended",
  "mention.recorded",
  "command.invoked",
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
  "knowledge.promoted",
  "audit.logged",
  "org.created",
  "client.registered",
] as const;

export const eventTypeSchema = z.enum(eventTypes);
export type EventType = z.infer<typeof eventTypeSchema>;

export type DomainEvent = {
  type: EventType;
  payload: Record<string, unknown>;
  orgId: string;
  streamId: string | null;
  streamSeq: number | null;
  createdAt: string;
};

export type AuditRow = {
  id: string;
  eventType: EventType;
  payload: Record<string, unknown>;
  prevHash: string | null;
  eventHash: string;
  createdAt: string;
};

export class PermissionError extends Error {
  public readonly code = "PERMISSION_DENIED";
  public readonly capability: string | null;
  public readonly resourceType: string | null;
  public readonly resourceId: string | null;
  constructor(
    message: string,
    info: { capability?: string | null; resourceType?: string | null; resourceId?: string | null } = {},
  ) {
    super(message);
    this.name = "PermissionError";
    this.capability = info.capability ?? null;
    this.resourceType = info.resourceType ?? null;
    this.resourceId = info.resourceId ?? null;
  }
}

export class ValidationError extends Error {
  public readonly code = "VALIDATION";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  public readonly code = "NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
