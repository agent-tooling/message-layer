import type { DomainEvent, EventType } from "./types.js";

/**
 * Transport-level event support contract.
 *
 * Keep this map exhaustive: any newly added EventType must be explicitly
 * classified here (TypeScript enforces this via `satisfies`).
 */
export const webhookEventSupport = {
  "channel.created": true,
  "thread.created": true,
  "message.appended": true,
  "mention.recorded": true,
  "command.invoked": true,
  "message.redacted": true,
  "membership.updated": true,
  "cursor.updated": true,
  "grant.created": true,
  "grant.revoked": true,
  "permission_request.created": true,
  "permission_request.resolved": true,
  "privacy_policy.updated": true,
  "artifact.registered": true,
  "artifact.deleted": true,
  "knowledge.promoted": true,
  "audit.logged": true,
  "org.created": true,
  "client.registered": true,
} as const satisfies Record<EventType, boolean>;

export type WebSocketEventDeliveryMode = "stream-scoped" | "not-delivered";

/**
 * WebSocket delivery is stream-subscription based, so only stream-scoped
 * events are routable. Org-level events remain available via HTTP/webhooks.
 */
export const webSocketEventSupport = {
  "channel.created": "stream-scoped",
  "thread.created": "stream-scoped",
  "message.appended": "stream-scoped",
  "mention.recorded": "stream-scoped",
  "command.invoked": "stream-scoped",
  "message.redacted": "stream-scoped",
  "membership.updated": "stream-scoped",
  "cursor.updated": "stream-scoped",
  "grant.created": "not-delivered",
  "grant.revoked": "not-delivered",
  "permission_request.created": "not-delivered",
  "permission_request.resolved": "not-delivered",
  "privacy_policy.updated": "not-delivered",
  "artifact.registered": "stream-scoped",
  "artifact.deleted": "stream-scoped",
  "knowledge.promoted": "stream-scoped",
  "audit.logged": "not-delivered",
  "org.created": "not-delivered",
  "client.registered": "not-delivered",
} as const satisfies Record<EventType, WebSocketEventDeliveryMode>;

export function isWebhookSupportedEventType(eventType: EventType): boolean {
  return webhookEventSupport[eventType];
}

export function getWebSocketEventDeliveryMode(eventType: EventType): WebSocketEventDeliveryMode {
  return webSocketEventSupport[eventType];
}

export function isWebSocketEventDeliverable(event: DomainEvent): boolean {
  return getWebSocketEventDeliveryMode(event.type) === "stream-scoped" && event.streamId !== null;
}
