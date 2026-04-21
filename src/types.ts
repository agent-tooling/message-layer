import { z } from "zod";

export const actorTypeSchema = z.enum(["human", "agent", "app"]);
export type ActorType = z.infer<typeof actorTypeSchema>;

export const visibilitySchema = z.enum(["private", "public"]);
export type Visibility = z.infer<typeof visibilitySchema>;

export const messagePartTypes = [
  "text",
  "tool_call",
  "tool_result",
  "artifact",
  "approval_request",
  "approval_response",
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

export const eventTypes = [
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
