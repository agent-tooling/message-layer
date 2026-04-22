/**
 * Unit tests for the `ui` message part type.
 *
 * The `ui` part carries a json-render spec in its payload. The service layer
 * treats it like any other part — the spec is an opaque JSON blob stored in
 * the message_parts table. Rendering happens on the client only.
 *
 * No mocks — real PGlite DB via createServiceHarness().
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOrg, createServiceHarness, principalFor } from "../helpers/harness.js";
import { messagePartTypes } from "../../src/types.js";

let harness: Awaited<ReturnType<typeof createServiceHarness>>;

beforeEach(async () => {
  harness = await createServiceHarness();
});
afterEach(async () => {
  await harness.close();
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSpec(id = "card-1") {
  return {
    root: id,
    elements: {
      [id]: {
        type: "Card",
        props: { title: "Launch Metrics" },
        children: [`metric-${id}`],
      },
      [`metric-${id}`]: {
        type: "Metric",
        props: { label: "PRs merged", value: "42", description: "this sprint" },
        children: [],
      },
    },
  };
}

async function bootstrapChannel(visibility: "public" | "private" = "public") {
  const { orgId, admin } = await bootstrapOrg(harness.service);
  const channelId = await harness.service.createChannel(admin, "general", visibility);
  return { orgId, admin, channelId };
}

// ── schema ────────────────────────────────────────────────────────────────────

describe("messagePartTypes enum", () => {
  test("includes 'ui'", () => {
    expect(messagePartTypes).toContain("ui");
  });

  test("includes first-class mention and command parts", () => {
    expect(messagePartTypes).toContain("mention");
    expect(messagePartTypes).toContain("command");
  });

  test("'ui' remains in the canonical part list", () => {
    const idx = messagePartTypes.indexOf("ui");
    expect(idx).toBeGreaterThanOrEqual(0);
  });
});

// ── service: roundtrip ────────────────────────────────────────────────────────

describe("service: ui message parts", () => {
  test("appendMessage accepts a ui part and stores spec verbatim", async () => {
    const { admin, channelId } = await bootstrapChannel();
    const spec = makeSpec("c1");

    const result = await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "ui", payload: { catalog: "shadcn", spec } }],
      idempotencyKey: "ui-test-1",
    });
    expect("denied" in result && result.denied).toBe(false);
    if ("denied" in result && result.denied) throw new Error("unexpected deny");
    expect(result.streamSeq).toBe(1);

    const messages = await harness.service.listMessages(
      admin,
      channelId,
      { afterSeq: 0, limit: 10 },
    );
    expect(messages).toHaveLength(1);
    const [msg] = messages;
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0].type).toBe("ui");
    expect(msg.parts[0].payload.catalog).toBe("shadcn");

    // spec is stored as-is
    const storedSpec = msg.parts[0].payload.spec as typeof spec;
    expect(storedSpec.root).toBe("c1");
    expect(storedSpec.elements["c1"].type).toBe("Card");
    expect(storedSpec.elements["metric-c1"].props.label).toBe("PRs merged");
  });

  test("ui part can coexist with text parts in the same message", async () => {
    const { admin, channelId } = await bootstrapChannel();
    const spec = makeSpec("c2");

    const result = await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [
        { type: "text", payload: { text: "Here is the dashboard:" } },
        { type: "ui", payload: { catalog: "shadcn", spec } },
      ],
      idempotencyKey: "ui-combo-1",
    });
    if ("denied" in result && result.denied) throw new Error("unexpected deny");

    const messages = await harness.service.listMessages(admin, channelId, { afterSeq: 0, limit: 10 });
    const [msg] = messages;
    expect(msg.parts).toHaveLength(2);
    expect(msg.parts[0].type).toBe("text");
    expect(msg.parts[1].type).toBe("ui");
  });

  test("ui part with complex nested spec roundtrips all element types", async () => {
    const { admin, channelId } = await bootstrapChannel();
    const complexSpec = {
      root: "stack-1",
      elements: {
        "stack-1": { type: "Stack", props: { direction: "vertical", gap: 4 }, children: ["heading-1", "table-1", "alert-1"] },
        "heading-1": { type: "Heading", props: { level: 2, text: "Weekly summary" }, children: [] },
        "table-1": { type: "Table", props: {}, children: ["row-1", "row-2"] },
        "row-1": { type: "TableRow", props: {}, children: ["cell-h1", "cell-h2"] },
        "row-2": { type: "TableRow", props: {}, children: ["cell-1", "cell-2"] },
        "cell-h1": { type: "TableCell", props: { header: true, text: "Name" }, children: [] },
        "cell-h2": { type: "TableCell", props: { header: true, text: "Status" }, children: [] },
        "cell-1": { type: "TableCell", props: { text: "coder-bot" }, children: [] },
        "cell-2": { type: "TableCell", props: { text: "Active" }, children: [] },
        "alert-1": { type: "Alert", props: { variant: "success", title: "All green", message: "No failing jobs." }, children: [] },
      },
    };

    await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "ui", payload: { catalog: "shadcn", spec: complexSpec } }],
      idempotencyKey: "ui-complex-1",
    });

    const messages = await harness.service.listMessages(admin, channelId, { afterSeq: 0, limit: 10 });
    const stored = (messages[0].parts[0].payload.spec as typeof complexSpec);
    expect(Object.keys(stored.elements)).toHaveLength(10);
    expect(stored.elements["alert-1"].props.variant).toBe("success");
  });

  test("ui part is counted in audit event partCount", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();

    await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [
        { type: "text", payload: { text: "intro" } },
        { type: "ui", payload: { catalog: "shadcn", spec: makeSpec("audit-c") } },
      ],
      idempotencyKey: "ui-audit-1",
    });

    const rows = await harness.service.auditRows(orgId, {});
    const appendedRow = rows.find((r) => r.eventType === "message.appended");
    expect(appendedRow).toBeDefined();
    // partCount reflects both parts
    expect((appendedRow!.payload as { partCount: number }).partCount).toBe(2);
  });

  test("ui part respects private channel scope — non-member cannot list messages", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const channelId = await harness.service.createChannel(admin, "private-ui", "private");

    const outsider = await principalFor(harness.service, orgId, "outsider", "human", []);

    await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "ui", payload: { catalog: "shadcn", spec: makeSpec("priv-c") } }],
      idempotencyKey: "ui-priv-1",
    });

    await expect(
      harness.service.listMessages(outsider, channelId, { afterSeq: 0, limit: 10 }),
    ).rejects.toThrow();
  });

  test("idempotency: posting the same ui spec twice returns the same messageId", async () => {
    const { admin, channelId } = await bootstrapChannel();
    const spec = makeSpec("idem-c");
    const payload = { catalog: "shadcn", spec };

    const r1 = await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "ui", payload }],
      idempotencyKey: "ui-idem-key",
    });
    const r2 = await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "ui", payload }],
      idempotencyKey: "ui-idem-key",
    });

    if ("denied" in r1 && r1.denied) throw new Error("denied");
    if ("denied" in r2 && r2.denied) throw new Error("denied");
    expect(r2.idempotent).toBe(true);
    expect(r2.messageId).toBe(r1.messageId);
  });
});
