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

export type DomainEvent = {
  orgId: string;
  streamId: string | null;
  type: string;
  payload: Record<string, unknown>;
  streamSeq: number | null;
  createdAt: string;
};
