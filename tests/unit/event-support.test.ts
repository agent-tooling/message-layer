import { describe, expect, test } from "vitest";
import { eventTypes, type DomainEvent } from "../../src/types.js";
import {
  getWebSocketEventDeliveryMode,
  isWebSocketEventDeliverable,
  webhookEventSupport,
  webSocketEventSupport,
} from "../../src/event-support.js";

describe("event transport support contracts", () => {
  test("webhook map stays aligned with canonical eventTypes", () => {
    expect(new Set(Object.keys(webhookEventSupport))).toEqual(new Set(eventTypes));
  });

  test("websocket map stays aligned with canonical eventTypes", () => {
    expect(new Set(Object.keys(webSocketEventSupport))).toEqual(new Set(eventTypes));
  });

  test("websocket deliverability is stream-scoped and requires streamId", () => {
    const orgEvent: DomainEvent = {
      type: "org.created",
      payload: { orgId: "o1" },
      orgId: "o1",
      streamId: null,
      streamSeq: null,
      createdAt: new Date().toISOString(),
    };
    expect(getWebSocketEventDeliveryMode(orgEvent.type)).toBe("not-delivered");
    expect(isWebSocketEventDeliverable(orgEvent)).toBe(false);

    const streamEvent: DomainEvent = {
      type: "message.appended",
      payload: { streamId: "s1" },
      orgId: "o1",
      streamId: "s1",
      streamSeq: 1,
      createdAt: new Date().toISOString(),
    };
    expect(getWebSocketEventDeliveryMode(streamEvent.type)).toBe("stream-scoped");
    expect(isWebSocketEventDeliverable(streamEvent)).toBe(true);
  });
});
