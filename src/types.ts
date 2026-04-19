import { z } from "zod";

export const actorTypeSchema = z.enum(["human", "agent", "app"]);
export type ActorType = z.infer<typeof actorTypeSchema>;

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
  scopes: z.array(z.string()).default([]),
  provider: z.string().min(1),
});
export type Principal = z.infer<typeof principalSchema>;

export const messagePartSchema = z.object({
  type: messagePartTypeSchema,
  payload: z.record(z.unknown()).default({}),
});
export type MessagePart = z.infer<typeof messagePartSchema>;

export type MessageRecord = {
  id: string;
  streamSeq: number;
  actorId: string;
  createdAt: string;
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
  "knowledge.promoted",
  "audit.logged",
  "org.created",
  "client.registered",
] as const;

export const eventTypeSchema = z.enum(eventTypes);
export type EventType = z.infer<typeof eventTypeSchema>;
