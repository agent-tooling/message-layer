import { describe, expect, test, vi } from "vitest";
import { InProcessEventBus } from "../../src/event-bus.js";
import type { DomainEvent } from "../../src/types.js";

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    type: "message.appended",
    orgId: "org-1",
    streamId: "stream-1",
    streamSeq: 1,
    createdAt: new Date().toISOString(),
    payload: { ok: true },
    ...overrides,
  };
}

describe("InProcessEventBus", () => {
  test("delivers events to matching subscribers", () => {
    const bus = new InProcessEventBus();
    const all: string[] = [];
    const filtered: string[] = [];
    bus.subscribe((e) => all.push(e.type));
    bus.subscribe((e) => filtered.push(e.type), { types: ["cursor.updated"] });

    bus.publish(makeEvent({ type: "message.appended" }));
    bus.publish(makeEvent({ type: "cursor.updated" }));

    expect(all).toEqual(["message.appended", "cursor.updated"]);
    expect(filtered).toEqual(["cursor.updated"]);
  });

  test("orgId and streamId filters are respected", () => {
    const bus = new InProcessEventBus();
    const org1: string[] = [];
    const stream2: string[] = [];
    bus.subscribe((e) => org1.push(e.orgId), { orgId: "org-1" });
    bus.subscribe((e) => stream2.push(e.streamId ?? "null"), { streamId: "stream-2" });
    bus.publish(makeEvent({ orgId: "org-1", streamId: "stream-1" }));
    bus.publish(makeEvent({ orgId: "org-2", streamId: "stream-2" }));
    expect(org1).toEqual(["org-1"]);
    expect(stream2).toEqual(["stream-2"]);
  });

  test("listener errors are caught and logged without affecting others", () => {
    const logs: string[] = [];
    const bus = new InProcessEventBus((msg) => logs.push(msg));
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error("oops");
    });
    bus.subscribe(good);
    bus.publish(makeEvent());
    expect(good).toHaveBeenCalled();
    expect(logs.some((l) => l.includes("oops"))).toBe(true);
  });

  test("unsubscribe stops delivery", () => {
    const bus = new InProcessEventBus();
    const received: string[] = [];
    const unsub = bus.subscribe((e) => received.push(e.type));
    bus.publish(makeEvent());
    unsub();
    bus.publish(makeEvent());
    expect(received).toHaveLength(1);
  });
});
