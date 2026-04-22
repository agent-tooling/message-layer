import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrapOrg, createServiceHarness, principalFor } from "../helpers/harness.js";
import { NotFoundError, PermissionError, ValidationError } from "../../src/types.js";

let harness: Awaited<ReturnType<typeof createServiceHarness>>;

beforeEach(async () => {
  harness = await createServiceHarness();
});
afterEach(async () => {
  await harness.close();
});

async function bootstrapChannel(visibility: "public" | "private" = "public") {
  const { orgId, admin } = await bootstrapOrg(harness.service);
  const channelId = await harness.service.createChannel(admin, "general", visibility);
  return { orgId, admin, channelId };
}

// ── registerCommand ──────────────────────────────────────────────────────────

describe("service.registerCommand", () => {
  test("creates pending command + permission request; emits command.registration_requested", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "deploybot", "app");

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, payload: e.payload }));

    const { commandId, requestId } = await harness.service.registerCommand(app, {
      name: "deploy",
      description: "Deploy to an environment",
      argsSchema: { env: { type: "string" } },
    });

    expect(commandId).toBeTruthy();
    expect(requestId).toBeTruthy();

    const ev = received.find((e) => e.type === "command.registration_requested");
    expect(ev).toBeDefined();
    expect(ev?.payload.name).toBe("deploy");
    expect(ev?.payload.ownerActorId).toBe(app.actorId);
    expect(ev?.payload.commandId).toBe(commandId);
    expect(ev?.payload.requestId).toBe(requestId);
    expect(ev?.payload.channelId).toBeNull();

    // command is pending — not visible in listCommands yet
    expect(await harness.service.listCommands(admin)).toHaveLength(0);
  });

  test("pending command also lands in the audit log", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "bot", "app");
    await harness.service.registerCommand(app, { name: "ping" });

    const audit = await harness.service.auditRows(orgId);
    expect(audit.some((r) => r.eventType === "command.registration_requested")).toBe(true);
  });

  test("channel-scoped registration stores the channelId", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const app = await principalFor(harness.service, orgId, "bot", "app");

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, payload: e.payload }));

    const { commandId } = await harness.service.registerCommand(app, {
      name: "post",
      channelId,
    });
    expect(commandId).toBeTruthy();

    const ev = received.find((e) => e.type === "command.registration_requested");
    expect(ev?.payload.channelId).toBe(channelId);
  });

  test("rejects invalid name characters", async () => {
    const { orgId } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "bot", "app");
    for (const bad of ["bad name!", "a b", "cmd@host", "cmd/path"]) {
      await expect(
        harness.service.registerCommand(app, { name: bad }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });

  test("rejects empty / whitespace-only name", async () => {
    const { orgId } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "bot", "app");
    await expect(harness.service.registerCommand(app, { name: "   " })).rejects.toBeInstanceOf(ValidationError);
    await expect(harness.service.registerCommand(app, { name: "" })).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects channel-scoped registration for an unknown channelId", async () => {
    const { orgId } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "bot", "app");
    await expect(
      harness.service.registerCommand(app, { name: "ping", channelId: "channel-nonexistent" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("rejects channel from a different org", async () => {
    const { orgId } = await bootstrapOrg(harness.service);
    const { admin: admin2, channelId: foreignChannel } = await bootstrapChannel();
    const app = await principalFor(harness.service, orgId, "bot", "app");
    await expect(
      harness.service.registerCommand(app, { name: "ping", channelId: foreignChannel }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  test("rejects actor not in org", async () => {
    const { orgId } = await bootstrapOrg(harness.service);
    const outsider: import("../../src/types.js").Principal = {
      actorId: "nonexistent-actor",
      orgId,
      scopes: [],
      provider: "test",
    };
    await expect(
      harness.service.registerCommand(outsider, { name: "ping" }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  test("duplicate registration by same actor in same scope → ValidationError", async () => {
    const { orgId } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "bot", "app");
    await harness.service.registerCommand(app, { name: "run" });
    await expect(
      harness.service.registerCommand(app, { name: "run" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("after denial, same actor can re-register the same name", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "bot", "app");
    const { requestId } = await harness.service.registerCommand(app, { name: "run" });
    await harness.service.resolvePermissionRequest(admin, requestId, false);

    // disabled → registration slot is free again
    const { commandId } = await harness.service.registerCommand(app, { name: "run" });
    expect(commandId).toBeTruthy();
  });

  test("different actors may each register the same short name", async () => {
    const { orgId } = await bootstrapOrg(harness.service);
    const app1 = await principalFor(harness.service, orgId, "bot1", "app");
    const app2 = await principalFor(harness.service, orgId, "bot2", "app");
    const { commandId: id1 } = await harness.service.registerCommand(app1, { name: "ping" });
    const { commandId: id2 } = await harness.service.registerCommand(app2, { name: "ping" });
    expect(id1).not.toBe(id2);
  });
});

// ── resolvePermissionRequest — command:register branch ───────────────────────

describe("resolvePermissionRequest for command:register", () => {
  test("approval activates the command and emits command.registered", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "deploybot", "app");
    const { commandId, requestId } = await harness.service.registerCommand(app, { name: "deploy" });

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, payload: e.payload }));

    const result = await harness.service.resolvePermissionRequest(admin, requestId, true);
    expect(result.status).toBe("approved");
    expect(result.grantId).toBeNull();
    expect(result.commandId).toBe(commandId);

    const ev = received.find((e) => e.type === "command.registered");
    expect(ev).toBeDefined();
    expect(ev?.payload.commandId).toBe(commandId);
    expect(ev?.payload.name).toBe("deploy");
    expect(ev?.payload.ownerActorId).toBe(app.actorId);

    const active = await harness.service.listCommands(admin);
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("deploy");
    expect(active[0].status).toBe("active");
  });

  test("denial disables the command; no command.registered event; command stays invisible", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "deploybot", "app");
    const { requestId } = await harness.service.registerCommand(app, { name: "deploy" });

    const received: string[] = [];
    harness.bus.subscribe((e) => received.push(e.type));

    const result = await harness.service.resolvePermissionRequest(admin, requestId, false);
    expect(result.status).toBe("denied");
    expect(result.grantId).toBeNull();
    expect(received).not.toContain("command.registered");
    expect(await harness.service.listCommands(admin)).toHaveLength(0);
  });

  test("command:register approval does NOT create a generic grant", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "bot", "app");
    const { requestId } = await harness.service.registerCommand(app, { name: "go" });
    const result = await harness.service.resolvePermissionRequest(admin, requestId, true);
    expect(result.grantId).toBeNull();
  });

  test("approval lands in the audit log as permission_request.resolved + command.registered", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "bot", "app");
    const { requestId } = await harness.service.registerCommand(app, { name: "go" });
    await harness.service.resolvePermissionRequest(admin, requestId, true);
    const audit = await harness.service.auditRows(orgId);
    expect(audit.some((r) => r.eventType === "permission_request.resolved")).toBe(true);
    expect(audit.some((r) => r.eventType === "command.registered")).toBe(true);
  });

  test("resolving an already-resolved request throws ValidationError", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "bot", "app");
    const { requestId } = await harness.service.registerCommand(app, { name: "go" });
    await harness.service.resolvePermissionRequest(admin, requestId, true);
    await expect(
      harness.service.resolvePermissionRequest(admin, requestId, true),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("non-admin cannot resolve a command:register request", async () => {
    const { orgId } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "bot", "app");
    const stranger = await principalFor(harness.service, orgId, "stranger");
    const { requestId } = await harness.service.registerCommand(app, { name: "go" });
    await expect(
      harness.service.resolvePermissionRequest(stranger, requestId, true),
    ).rejects.toBeInstanceOf(PermissionError);
  });
});

// ── command invocation — short / long form resolution ────────────────────────

describe("command invocation — short/long form resolution", () => {
  async function setupRegisteredCommand(
    orgId: string,
    admin: Awaited<ReturnType<typeof bootstrapOrg>>["admin"],
    channelId: string,
    displayName: string,
    cmdName: string,
    cmdChannelId?: string | null,
  ) {
    const app = await principalFor(harness.service, orgId, displayName, "app");
    const { requestId } = await harness.service.registerCommand(app, {
      name: cmdName,
      channelId: cmdChannelId ?? null,
    });
    await harness.service.resolvePermissionRequest(admin, requestId, true);
    await harness.service.createGrant(admin, admin.actorId, "channel", channelId, "command:invoke");
    return app;
  }

  test("short-form resolves to registered command and enriches command.invoked with commandId + ownerActorId", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const app = await setupRegisteredCommand(orgId, admin, channelId, "deploybot", "ship");

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, payload: e.payload }));

    const result = await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "command", payload: { command: "ship", args: {} } }],
      idempotencyKey: "ship-1",
    });
    if ("denied" in result && result.denied) throw new Error("unexpected denial");

    const invoked = received.find((e) => e.type === "command.invoked");
    expect(invoked?.payload.command).toBe("ship");
    expect(typeof invoked?.payload.commandId).toBe("string");
    expect(invoked?.payload.ownerActorId).toBe(app.actorId);
  });

  test("long-form ownerName:cmdName resolves correctly", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const app = await setupRegisteredCommand(orgId, admin, channelId, "deploybot", "ship");

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, payload: e.payload }));

    await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "command", payload: { command: "deploybot:ship", args: {} } }],
      idempotencyKey: "long-1",
    });

    const invoked = received.find((e) => e.type === "command.invoked");
    expect(invoked?.payload.ownerActorId).toBe(app.actorId);
    expect(typeof invoked?.payload.commandId).toBe("string");
  });

  test("short-form is ambiguous when two owners hold the same name → ValidationError", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel("public");

    const app1 = await principalFor(harness.service, orgId, "bot1", "app");
    const { requestId: r1 } = await harness.service.registerCommand(app1, { name: "ping" });
    await harness.service.resolvePermissionRequest(admin, r1, true);

    const app2 = await principalFor(harness.service, orgId, "bot2", "app");
    const { requestId: r2 } = await harness.service.registerCommand(app2, { name: "ping" });
    await harness.service.resolvePermissionRequest(admin, r2, true);

    await harness.service.createGrant(admin, admin.actorId, "channel", channelId, "command:invoke");

    await expect(
      harness.service.appendMessage(admin, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "command", payload: { command: "ping", args: {} } }],
        idempotencyKey: "ambiguous-1",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("long-form resolves unambiguously even when short-form is ambiguous", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel("public");

    const app1 = await principalFor(harness.service, orgId, "bot1", "app");
    const { requestId: r1 } = await harness.service.registerCommand(app1, { name: "ping" });
    await harness.service.resolvePermissionRequest(admin, r1, true);

    const app2 = await principalFor(harness.service, orgId, "bot2", "app");
    const { requestId: r2 } = await harness.service.registerCommand(app2, { name: "ping" });
    await harness.service.resolvePermissionRequest(admin, r2, true);

    await harness.service.createGrant(admin, admin.actorId, "channel", channelId, "command:invoke");

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, payload: e.payload }));

    await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "command", payload: { command: "bot1:ping", args: {} } }],
      idempotencyKey: "long-unambiguous",
    });

    const invoked = received.find((e) => e.type === "command.invoked");
    expect(invoked?.payload.ownerActorId).toBe(app1.actorId);
  });

  test("unregistered command passes through with null commandId and ownerActorId (backward compat)", async () => {
    const { admin, channelId } = await bootstrapChannel();
    await harness.service.createGrant(admin, admin.actorId, "channel", channelId, "command:invoke");

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, payload: e.payload }));

    const result = await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "command", payload: { command: "totally-unknown", args: {} } }],
      idempotencyKey: "unreg-1",
    });
    if ("denied" in result && result.denied) throw new Error("unexpected denial");

    const invoked = received.find((e) => e.type === "command.invoked");
    expect(invoked?.payload.commandId).toBeNull();
    expect(invoked?.payload.ownerActorId).toBeNull();
  });

  test("channel-scoped command takes precedence over org-scoped command with same name", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel("public");

    const appOrg = await principalFor(harness.service, orgId, "orgbot", "app");
    const { requestId: rOrg } = await harness.service.registerCommand(appOrg, { name: "run" });
    await harness.service.resolvePermissionRequest(admin, rOrg, true);

    const appCh = await principalFor(harness.service, orgId, "chanbot", "app");
    const { requestId: rCh } = await harness.service.registerCommand(appCh, { name: "run", channelId });
    await harness.service.resolvePermissionRequest(admin, rCh, true);

    await harness.service.createGrant(admin, admin.actorId, "channel", channelId, "command:invoke");

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, payload: e.payload }));

    await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "command", payload: { command: "run", args: {} } }],
      idempotencyKey: "scoped-pref",
    });

    const invoked = received.find((e) => e.type === "command.invoked");
    expect(invoked?.payload.ownerActorId).toBe(appCh.actorId);
  });

  test("pending command is not resolved (treated as unregistered)", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel("public");
    const app = await principalFor(harness.service, orgId, "bot", "app");
    // register but do NOT approve
    await harness.service.registerCommand(app, { name: "pending-cmd" });

    await harness.service.createGrant(admin, admin.actorId, "channel", channelId, "command:invoke");

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, payload: e.payload }));

    await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "command", payload: { command: "pending-cmd", args: {} } }],
      idempotencyKey: "pending-invoke",
    });

    const invoked = received.find((e) => e.type === "command.invoked");
    expect(invoked?.payload.commandId).toBeNull();
  });

  test("long-form with empty command name after colon throws ValidationError", async () => {
    const { admin, channelId } = await bootstrapChannel("public");
    await harness.service.createGrant(admin, admin.actorId, "channel", channelId, "command:invoke");

    await expect(
      harness.service.appendMessage(admin, {
        streamId: channelId,
        streamType: "channel",
        parts: [{ type: "command", payload: { command: "bot:", args: {} } }],
        idempotencyKey: "badlong-1",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("long-form with empty owner name (leading colon) is treated as short form and passes as unregistered", async () => {
    // ':deploy' has colonIdx === 0 so it is treated as a short-form lookup, finds nothing, commandId=null
    const { admin, channelId } = await bootstrapChannel("public");
    await harness.service.createGrant(admin, admin.actorId, "channel", channelId, "command:invoke");

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, payload: e.payload }));

    await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "command", payload: { command: ":deploy", args: {} } }],
      idempotencyKey: "leading-colon",
    });

    const invoked = received.find((e) => e.type === "command.invoked");
    expect(invoked?.payload.commandId).toBeNull();
  });

  test("long-form with unknown ownerName falls through as unregistered, not an error", async () => {
    const { admin, channelId } = await bootstrapChannel("public");
    await harness.service.createGrant(admin, admin.actorId, "channel", channelId, "command:invoke");

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, payload: e.payload }));

    await harness.service.appendMessage(admin, {
      streamId: channelId,
      streamType: "channel",
      parts: [{ type: "command", payload: { command: "ghostbot:run", args: {} } }],
      idempotencyKey: "ghost-1",
    });

    const invoked = received.find((e) => e.type === "command.invoked");
    expect(invoked?.payload.commandId).toBeNull();
    expect(invoked?.payload.ownerActorId).toBeNull();
  });
});

// ── deleteCommand ────────────────────────────────────────────────────────────

describe("service.deleteCommand", () => {
  async function activeCommand(orgId: string, admin: Awaited<ReturnType<typeof bootstrapOrg>>["admin"], name: string, channelId?: string) {
    const app = await principalFor(harness.service, orgId, `bot-${name}`, "app");
    const { commandId, requestId } = await harness.service.registerCommand(app, { name, channelId: channelId ?? null });
    await harness.service.resolvePermissionRequest(admin, requestId, true);
    return { app, commandId };
  }

  test("owner can disable their own command; it disappears from listCommands", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const { app, commandId } = await activeCommand(orgId, admin, "run");

    expect(await harness.service.listCommands(admin)).toHaveLength(1);
    await harness.service.deleteCommand(app, commandId);
    expect(await harness.service.listCommands(admin)).toHaveLength(0);
  });

  test("admin (grant:create scope) can disable any command", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const { commandId } = await activeCommand(orgId, admin, "run");

    await harness.service.deleteCommand(admin, commandId);
    expect(await harness.service.listCommands(admin)).toHaveLength(0);
  });

  test("deleting a command emits command.deleted with all relevant fields", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const { app, commandId } = await activeCommand(orgId, admin, "deploy");

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    harness.bus.subscribe((e) => received.push({ type: e.type, payload: e.payload }));

    await harness.service.deleteCommand(app, commandId);

    const ev = received.find((e) => e.type === "command.deleted");
    expect(ev).toBeDefined();
    expect(ev?.payload.commandId).toBe(commandId);
    expect(ev?.payload.name).toBe("deploy");
    expect(ev?.payload.ownerActorId).toBe(app.actorId);
    expect(ev?.payload.deletedByActorId).toBe(app.actorId);
  });

  test("command.deleted lands in the audit log", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const { app, commandId } = await activeCommand(orgId, admin, "run");
    await harness.service.deleteCommand(app, commandId);

    const audit = await harness.service.auditRows(orgId);
    expect(audit.some((r) => r.eventType === "command.deleted")).toBe(true);
  });

  test("non-owner non-admin cannot delete a command → PermissionError", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const { commandId } = await activeCommand(orgId, admin, "run");

    const stranger = await principalFor(harness.service, orgId, "stranger");
    await expect(harness.service.deleteCommand(stranger, commandId)).rejects.toBeInstanceOf(PermissionError);
  });

  test("unknown commandId → NotFoundError", async () => {
    const { admin } = await bootstrapOrg(harness.service);
    await expect(harness.service.deleteCommand(admin, "nonexistent-cmd")).rejects.toBeInstanceOf(NotFoundError);
  });

  test("cross-org: principal from different org cannot delete a command → PermissionError", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const { commandId } = await activeCommand(orgId, admin, "run");

    const { admin: admin2 } = await bootstrapOrg(harness.service);
    await expect(harness.service.deleteCommand(admin2, commandId)).rejects.toBeInstanceOf(PermissionError);
  });

  test("deleting a pending command (not yet approved) works the same way", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "bot", "app");
    const { commandId } = await harness.service.registerCommand(app, { name: "run" });

    // pending — not yet approved; owner should still be able to pull it
    await harness.service.deleteCommand(app, commandId);

    // still doesn't appear in active commands
    expect(await harness.service.listCommands(admin)).toHaveLength(0);
  });
});

// ── listCommands ─────────────────────────────────────────────────────────────

describe("service.listCommands", () => {
  test("without channelId returns only org-scoped active commands", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const app = await principalFor(harness.service, orgId, "bot", "app");

    const { requestId: r1 } = await harness.service.registerCommand(app, { name: "global" });
    await harness.service.resolvePermissionRequest(admin, r1, true);

    const { requestId: r2 } = await harness.service.registerCommand(app, { name: "local", channelId });
    await harness.service.resolvePermissionRequest(admin, r2, true);

    const orgOnly = await harness.service.listCommands(admin);
    expect(orgOnly.map((c) => c.name)).toEqual(["global"]);
    expect(orgOnly[0].channelId).toBeNull();
  });

  test("with channelId returns both org-scoped and channel-scoped active commands", async () => {
    const { orgId, admin, channelId } = await bootstrapChannel();
    const app = await principalFor(harness.service, orgId, "bot", "app");

    const { requestId: r1 } = await harness.service.registerCommand(app, { name: "global" });
    await harness.service.resolvePermissionRequest(admin, r1, true);

    const { requestId: r2 } = await harness.service.registerCommand(app, { name: "local", channelId });
    await harness.service.resolvePermissionRequest(admin, r2, true);

    const all = await harness.service.listCommands(admin, channelId);
    expect(all.map((c) => c.name).sort()).toEqual(["global", "local"]);
  });

  test("pending and disabled commands are not returned", async () => {
    const { orgId, admin } = await bootstrapOrg(harness.service);
    const app = await principalFor(harness.service, orgId, "bot", "app");

    // pending
    await harness.service.registerCommand(app, { name: "pending-cmd" });

    // denied → disabled
    const { requestId: r2 } = await harness.service.registerCommand(
      await principalFor(harness.service, orgId, "bot2", "app"),
      { name: "denied-cmd" },
    );
    await harness.service.resolvePermissionRequest(admin, r2, false);

    expect(await harness.service.listCommands(admin)).toHaveLength(0);
  });

  test("commands from another org are not returned", async () => {
    const { orgId: orgId1, admin: admin1 } = await bootstrapOrg(harness.service);
    const { orgId: orgId2, admin: admin2 } = await bootstrapOrg(harness.service);

    const app1 = await principalFor(harness.service, orgId1, "bot1", "app");
    const { requestId: r1 } = await harness.service.registerCommand(app1, { name: "shared-name" });
    await harness.service.resolvePermissionRequest(admin1, r1, true);

    // org2 has no commands
    expect(await harness.service.listCommands(admin2)).toHaveLength(0);
  });
});
