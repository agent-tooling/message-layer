import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOrg, createServiceHarness, principalFor } from "../helpers/harness.js";
import { PermissionError, ValidationError } from "../../src/types.js";

let harness: Awaited<ReturnType<typeof createServiceHarness>>;

beforeEach(async () => {
  harness = await createServiceHarness();
});
afterEach(async () => {
  await harness.close();
});

async function bootstrapChannel(scoped: "public" | "private" = "public") {
  const { orgId, admin } = await bootstrapOrg(harness.service);
  const channelId = await harness.service.createChannel(admin, "general", scoped);
  return { orgId, admin, channelId };
}

describe("service.appendMessage", () => {
  test("returns streamSeq=1 for first message, 2 for second, idempotent replay for same key", async () => {
    const { admin, channelId } = await bootstrapChannel();
    const a = await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "a" } }],
      idempotencyKey: "a-1",
    });
    const b = await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "b" } }],
      idempotencyKey: "b-1",
    });
    const c = await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "dup" } }],
      idempotencyKey: "a-1",
    });
    if ("denied" in a && a.denied) throw new Error();
    if ("denied" in b && b.denied) throw new Error();
    if ("denied" in c && c.denied) throw new Error();
    expect(a.streamSeq).toBe(1);
    expect(b.streamSeq).toBe(2);
    expect(c.idempotent).toBe(true);
    expect(c.messageId).toBe(a.messageId);
  });

  test("rejects unknown part type", async () => {
    const { admin, channelId } = await bootstrapChannel();
    await expect(
      harness.service.appendMessage(admin, {
        streamId: channelId,
        streamType: "channel",
        // @ts-expect-error deliberate
        parts: [{ type: "bogus", payload: {} }],
        idempotencyKey: "x",
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("rejects empty parts", async () => {
    const { admin, channelId } = await bootstrapChannel();
    await expect(
      harness.service.appendMessage(admin, {
        streamId: channelId,
        streamType: "channel",
        parts: [],
        idempotencyKey: "x",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects principal without grant", async () => {
    const { orgId, channelId } = await bootstrapChannel("public");
    const bob = await principalFor(harness.service, orgId, "bob");
    await expect(
      harness.service.appendMessage(bob, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "no" } }],
        idempotencyKey: "b-1",
      }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  test("autoRequestOnDeny returns a permission request instead of throwing", async () => {
    const { orgId, channelId } = await bootstrapChannel("public");
    const bob = await principalFor(harness.service, orgId, "bob");
    const res = await harness.service.appendMessage(bob, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "hi" } }],
      idempotencyKey: "b-1",
      autoRequestOnDeny: true,
    });
    if (!("denied" in res) || !res.denied) throw new Error("expected denial");
    expect(res.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(res.capability).toBe("message:append");
  });

  test("private channel membership is required even with message:append scope", async () => {
    // A principal with scope `message:append` shortcuts capability checks,
    // but must still pass privacy: not a channel member of a private channel.
    const { orgId, admin, channelId } = await bootstrapChannel("private");
    const bot = await principalFor(harness.service, orgId, "bot", "agent", ["message:append"]);
    await expect(
      harness.service.appendMessage(bot, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "text", payload: { text: "peek" } }],
        idempotencyKey: "x",
      }),
    ).rejects.toBeInstanceOf(PermissionError);
    await harness.service.addChannelMember(admin, channelId, bot.actorId);
    const ok = await harness.service.appendMessage(bot, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "peek" } }],
      idempotencyKey: "x",
    });
    if ("denied" in ok && ok.denied) throw new Error("unexpected denial");
    expect(ok.streamSeq).toBe(1);
  });

  test("emits message.appended event on the shared bus", async () => {
    const { admin, channelId } = await bootstrapChannel();
    const received: Array<{ type: string; seq: number | null }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, seq: e.streamSeq }));
    await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "hi" } }],
      idempotencyKey: "b",
    });
    const appended = received.find((r) => r.type === "message.appended");
    expect(appended).toBeDefined();
    expect(appended?.seq).toBe(1);
  });

  test("records mention and command events for first-class parts", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel("private");
    const mentioned = await principalFor(harness.service, orgId, "mentioned");
    await harness.service.addChannelMember(admin, channelId, mentioned.actorId);
    await harness.service.createGrant(
      admin,
      admin.actorId,
      "channel",
      channelId,
      "command:invoke",
    );

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((event) => received.push({ type: event.type, payload: event.payload }));

    const result = await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [
        { type: "text", payload: { text: "Run deploy for @mentioned" } },
        {
          type: "mention",
          payload: { actorId: mentioned.actorId, label: "@mentioned", start: 15, end: 25 },
        },
        {
          type: "command",
          payload: { command: "deploy", args: { env: "prod" }, invocationId: "inv-1" },
        },
      ],
      idempotencyKey: "mention-command-1",
    });
    if ("denied" in result && result.denied) throw new Error("unexpected deny");

    const mentionEvent = received.find((event) => event.type === "mention.recorded");
    expect(mentionEvent).toBeDefined();
    expect(mentionEvent?.payload.mentionedActorId).toBe(mentioned.actorId);

    const commandEvent = received.find((event) => event.type === "command.invoked");
    expect(commandEvent).toBeDefined();
    expect(commandEvent?.payload.command).toBe("deploy");
    expect(commandEvent?.payload.invocationId).toBe("inv-1");
  });

  test("rejects mention of actor outside org", async () => {
    const { admin, channelId } = await bootstrapChannel("public");
    const otherOrgId = await harness.service.createOrg("other");
    const outsider = await principalFor(harness.service, otherOrgId, "outsider");
    await expect(
      harness.service.appendMessage(admin, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "mention", payload: { actorId: outsider.actorId } }],
        idempotencyKey: "mention-outside-org",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects mention of non-member in private channel", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel("private");
    const nonMember = await principalFor(harness.service, orgId, "non-member");
    await expect(
      harness.service.appendMessage(admin, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "mention", payload: { actorId: nonMember.actorId } }],
        idempotencyKey: "mention-private-non-member",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("requires command:invoke for command parts", async () => {
    const { orgId, channelId, admin } = await bootstrapChannel("public");
    const bob = await principalFor(harness.service, orgId, "bob");
    await harness.service.createGrant(admin, bob.actorId, "channel", channelId, "message:append");
    await expect(
      harness.service.appendMessage(bob, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "command", payload: { command: "help", args: { topic: "build" } } }],
        idempotencyKey: "command-without-capability",
      }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  test("command part denial can auto-open permission request", async () => {
    const { orgId, channelId, admin } = await bootstrapChannel("public");
    const bob = await principalFor(harness.service, orgId, "bob");
    await harness.service.createGrant(admin, bob.actorId, "channel", channelId, "message:append");
    const denied = await harness.service.appendMessage(bob, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "command", payload: { command: "status", args: { verbose: true } } }],
      idempotencyKey: "command-auto-request",
      autoRequestOnDeny: true,
    });
    if (!("denied" in denied) || !denied.denied) throw new Error("expected denied result");
    expect(denied.capability).toBe("command:invoke");
    const request = await harness.service.getPermissionRequest(orgId, denied.requestId);
    expect(request?.action).toBe("command:invoke");
    expect(request?.context.kind).toBe("command.invoke");
  });
});

describe("service.redactMessage", () => {
  test("author can redact own message; parts disappear but slot stays", async () => {
    const { admin, channelId } = await bootstrapChannel();
    const appended = await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "oops" } }],
      idempotencyKey: "a",
    });
    if ("denied" in appended && appended.denied) throw new Error();
    await harness.service.redactMessage(admin, appended.messageId, "typo");
    const [msg] = await harness.service.listMessages(admin, channelId, { streamType: "channel" });
    expect(msg.redacted).toBe(true);
    expect(msg.parts).toHaveLength(0);
    expect(msg.streamSeq).toBe(appended.streamSeq);
  });

  test("other principal without message:redact cannot redact", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const bob = await principalFor(harness.service, orgId, "bob");
    await harness.service.createGrant(admin, bob.actorId, "channel", channelId, "message:append");
    const msg = await harness.service.appendMessage(bob, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "text", payload: { text: "mine" } }],
      idempotencyKey: "a",
    });
    if ("denied" in msg && msg.denied) throw new Error();
    const carol = await principalFor(harness.service, orgId, "carol");
    await expect(harness.service.redactMessage(carol, msg.messageId)).rejects.toBeInstanceOf(PermissionError);
  });
});
