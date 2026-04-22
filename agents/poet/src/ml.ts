/**
 * Tiny HTTP client for message-layer. Keeps the poet agent's surface area
 * obvious: every call is one function that returns either the success body
 * or a structured `{ denied, code, requestId? }` error so the Mastra tools
 * can render the permission flow back to the LLM.
 */

import { randomUUID } from "node:crypto";

export type Principal = {
  actorId: string;
  orgId: string;
  scopes: string[];
  provider: string;
};

export type MlChannel = {
  id: string;
  name: string;
  visibility: "private" | "public";
  createdByActorId: string;
  createdAt: string;
};

export type MlMessage = {
  id: string;
  streamSeq: number;
  actorId: string;
  createdAt: string;
  parts: Array<{ type: string; payload: Record<string, unknown> }>;
};
type MlPartType =
  | "text"
  | "mention"
  | "command"
  | "tool_call"
  | "tool_result"
  | "artifact"
  | "approval_request"
  | "approval_response";
type MlPart = { type: MlPartType; payload: Record<string, unknown> };

export type MlAppendResult =
  | { ok: true; messageId: string; streamSeq: number; idempotent: boolean }
  | {
      ok: false;
      code: "permission_denied" | "not_found" | "validation" | "unknown";
      message: string;
      requestId?: string;
      capability?: string;
    };

type PermissionDecision = "open" | "approved" | "denied";

export class MessageLayerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly principal: Principal | null = null,
  ) {}

  withPrincipal(principal: Principal): MessageLayerClient {
    return new MessageLayerClient(this.baseUrl, principal);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.principal) h["x-principal"] = JSON.stringify(this.principal);
    return h;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T | Record<string, unknown> }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = {};
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    return { status: res.status, body: parsed as T };
  }

  private async getPermissionRequestStatus(requestId: string): Promise<PermissionDecision> {
    try {
      const { status, body } = await this.call<{ request?: { status?: PermissionDecision } }>(
        "GET",
        `/v1/permission-requests/${requestId}`,
      );
      if (status === 200) {
        const requestStatus = (body as { request?: { status?: PermissionDecision } }).request?.status;
        if (requestStatus === "open" || requestStatus === "approved" || requestStatus === "denied") {
          return requestStatus;
        }
      }
    } catch {
      // best effort: assume still pending
    }
    return "open";
  }

  private async waitForPermissionDecision(
    requestId: string,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<PermissionDecision> {
    const timeoutMs = opts.timeoutMs ?? Number(process.env.POET_PERMISSION_TIMEOUT_MS ?? "300000");
    const pollIntervalMs = opts.pollIntervalMs ?? Number(process.env.POET_PERMISSION_POLL_MS ?? "2000");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.getPermissionRequestStatus(requestId);
      if (status === "approved" || status === "denied") return status;
      if (Date.now() >= deadline) return "open";
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async createOrg(name: string): Promise<string> {
    const { status, body } = await this.call<{ orgId: string }>("POST", "/v1/orgs", { name });
    if (status !== 200) throw new Error(`createOrg failed ${status}: ${JSON.stringify(body)}`);
    return (body as { orgId: string }).orgId;
  }

  async createActor(orgId: string, actorType: "human" | "agent" | "app", displayName: string): Promise<string> {
    const { status, body } = await this.call<{ actorId: string }>("POST", "/v1/actors", {
      orgId,
      actorType,
      displayName,
    });
    if (status !== 200) throw new Error(`createActor failed ${status}: ${JSON.stringify(body)}`);
    return (body as { actorId: string }).actorId;
  }

  async listChannels(): Promise<MlChannel[]> {
    const { status, body } = await this.call<{ channels: MlChannel[] }>("GET", "/v1/channels");
    if (status !== 200) throw new Error(`listChannels failed ${status}: ${JSON.stringify(body)}`);
    return (body as { channels: MlChannel[] }).channels;
  }

  async createChannel(name: string, visibility: "public" | "private" = "public"): Promise<
    | { ok: true; channelId: string }
    | { ok: false; code: "permission_denied" | "validation" | "unknown"; message: string; requestId?: string; capability?: string }
  > {
    const { status, body } = await this.call<{ channelId?: string; code?: string; error?: string; capability?: string }>(
      "POST",
      "/v1/channels",
      { name, visibility },
    );
    if (status === 200 && body && typeof (body as { channelId?: string }).channelId === "string") {
      return { ok: true, channelId: (body as { channelId: string }).channelId };
    }
    if (status === 403) {
      const capability = (body as { capability?: string }).capability ?? "channel:create";
      // Include the agent's actual intent (channel name + visibility) so the
      // human reviewer can tell at a glance what they're approving — this is
      // the "purpose-aware permissions" point in AGENTS.md rule 5.
      const requestId = await this.openPermissionRequest(
        capability,
        "org",
        this.principal?.orgId ?? null,
        {
          kind: "channel.create",
          tool: "create_channel",
          requestedName: name,
          requestedVisibility: visibility,
          args: { name, visibility },
        },
      );
      return {
        ok: false,
        code: "permission_denied",
        message: (body as { error?: string }).error ?? "permission denied",
        capability,
        requestId,
      };
    }
    const code =
      (body as { code?: string }).code === "VALIDATION"
        ? "validation"
        : (body as { code?: string }).code === "NOT_FOUND"
          ? "validation"
          : "unknown";
    return {
      ok: false,
      code: code as "validation" | "unknown",
      message: (body as { error?: string }).error ?? `create channel failed: HTTP ${status}`,
    };
  }

  async appendMessage(opts: {
    streamId: string;
    streamType: "channel" | "thread";
    text: string;
    idempotencyKey?: string;
  }): Promise<MlAppendResult> {
    return this.appendMessageInternal(opts, true);
  }

  private async appendMessageInternal(
    opts: {
      streamId: string;
      streamType: "channel" | "thread";
      text: string;
      idempotencyKey?: string;
    },
    waitOnDeny: boolean,
  ): Promise<MlAppendResult> {
    const { status, body } = await this.call<{
      messageId?: string;
      streamSeq?: number;
      idempotent?: boolean;
      denied?: boolean;
      requestId?: string;
      capability?: string;
      code?: string;
      error?: string;
    }>("POST", "/v1/messages", {
      streamId: opts.streamId,
      streamType: opts.streamType,
      parts: [{ type: "text", payload: { text: opts.text } }],
      idempotencyKey: opts.idempotencyKey ?? `poet-${randomUUID()}`,
      autoRequestOnDeny: true,
    });
    const b = body as {
      messageId?: string;
      streamSeq?: number;
      idempotent?: boolean;
      denied?: boolean;
      requestId?: string;
      capability?: string;
      code?: string;
      error?: string;
    };
    if (status === 200 && b.denied === true && b.requestId) {
      if (waitOnDeny) {
        const decision = await this.waitForPermissionDecision(b.requestId);
        if (decision === "approved") {
          return this.appendMessageInternal(opts, false);
        }
        if (decision === "denied") {
          return {
            ok: false,
            code: "permission_denied",
            message: `request ${b.requestId} was denied by an admin`,
            requestId: b.requestId,
            capability: b.capability ?? "message:append",
          };
        }
        return {
          ok: false,
          code: "permission_denied",
          message: `request ${b.requestId} is still pending admin approval`,
          requestId: b.requestId,
          capability: b.capability ?? "message:append",
        };
      }
      return {
        ok: false,
        code: "permission_denied",
        message: "append denied; auto-opened permission request",
        requestId: b.requestId,
        capability: b.capability ?? "message:append",
      };
    }
    if (status === 200 && typeof b.messageId === "string" && typeof b.streamSeq === "number") {
      return { ok: true, messageId: b.messageId, streamSeq: b.streamSeq, idempotent: Boolean(b.idempotent) };
    }
    if (status === 403) {
      return {
        ok: false,
        code: "permission_denied",
        message: b.error ?? "permission denied",
        capability: b.capability ?? "message:append",
      };
    }
    if (status === 404) {
      return { ok: false, code: "not_found", message: b.error ?? "stream not found" };
    }
    return {
      ok: false,
      code: "unknown",
      message: b.error ?? `append failed: HTTP ${status}`,
    };
  }

  async appendParts(opts: {
    streamId: string;
    streamType: "channel" | "thread";
    parts: MlPart[];
    idempotencyKey?: string;
  }): Promise<MlAppendResult> {
    return this.appendPartsInternal(opts, true);
  }

  private async appendPartsInternal(
    opts: {
      streamId: string;
      streamType: "channel" | "thread";
      parts: MlPart[];
      idempotencyKey?: string;
    },
    waitOnDeny: boolean,
  ): Promise<MlAppendResult> {
    const { status, body } = await this.call<{
      messageId?: string;
      streamSeq?: number;
      idempotent?: boolean;
      denied?: boolean;
      requestId?: string;
      capability?: string;
      code?: string;
      error?: string;
    }>("POST", "/v1/messages", {
      streamId: opts.streamId,
      streamType: opts.streamType,
      parts: opts.parts,
      idempotencyKey: opts.idempotencyKey ?? `poet-parts-${randomUUID()}`,
      autoRequestOnDeny: true,
    });
    const b = body as {
      messageId?: string;
      streamSeq?: number;
      idempotent?: boolean;
      denied?: boolean;
      requestId?: string;
      capability?: string;
      code?: string;
      error?: string;
    };
    if (status === 200 && b.denied === true && b.requestId) {
      if (waitOnDeny) {
        const decision = await this.waitForPermissionDecision(b.requestId);
        if (decision === "approved") {
          return this.appendPartsInternal(opts, false);
        }
        if (decision === "denied") {
          return {
            ok: false,
            code: "permission_denied",
            message: `request ${b.requestId} was denied by an admin`,
            requestId: b.requestId,
            capability: b.capability ?? "message:append",
          };
        }
        return {
          ok: false,
          code: "permission_denied",
          message: `request ${b.requestId} is still pending admin approval`,
          requestId: b.requestId,
          capability: b.capability ?? "message:append",
        };
      }
      return {
        ok: false,
        code: "permission_denied",
        message: "append denied; auto-opened permission request",
        requestId: b.requestId,
        capability: b.capability ?? "message:append",
      };
    }
    if (status === 200 && typeof b.messageId === "string" && typeof b.streamSeq === "number") {
      return { ok: true, messageId: b.messageId, streamSeq: b.streamSeq, idempotent: Boolean(b.idempotent) };
    }
    if (status === 404) {
      return { ok: false, code: "not_found", message: b.error ?? "stream not found" };
    }
    return {
      ok: false,
      code: "unknown",
      message: b.error ?? `append failed: HTTP ${status}`,
    };
  }

  async createThread(
    channelId: string,
    parentMessageId: string,
    visibility: "public" | "private" = "public",
  ): Promise<
    | { ok: true; threadId: string }
    | { ok: false; code: "permission_denied" | "validation" | "not_found" | "unknown"; message: string; requestId?: string; capability?: string }
  > {
    return this.createThreadInternal(channelId, parentMessageId, visibility, true);
  }

  private async createThreadInternal(
    channelId: string,
    parentMessageId: string,
    visibility: "public" | "private",
    waitOnDeny: boolean,
  ): Promise<
    | { ok: true; threadId: string }
    | { ok: false; code: "permission_denied" | "validation" | "not_found" | "unknown"; message: string; requestId?: string; capability?: string }
  > {
    const { status, body } = await this.call<{
      threadId?: string;
      error?: string;
      capability?: string;
      code?: string;
      denied?: boolean;
      requestId?: string;
    }>("POST", "/v1/threads", {
      channelId,
      parentMessageId,
      visibility,
    });
    const payload = body as {
      threadId?: string;
      error?: string;
      capability?: string;
      code?: string;
      denied?: boolean;
      requestId?: string;
    };
    if (status === 200 && typeof payload.threadId === "string") {
      return { ok: true, threadId: payload.threadId };
    }
    if (status === 403) {
      const capability = payload.capability ?? "thread:create";
      const requestId = await this.openPermissionRequest(
        capability,
        "channel",
        channelId,
        {
          kind: "thread.create",
          tool: "poem_command_reply",
          parentMessageId,
          channelId,
          requestedVisibility: visibility,
        },
      );
      if (waitOnDeny && requestId) {
        const decision = await this.waitForPermissionDecision(requestId);
        if (decision === "approved") {
          return this.createThreadInternal(channelId, parentMessageId, visibility, false);
        }
        if (decision === "denied") {
          return {
            ok: false,
            code: "permission_denied",
            message: `request ${requestId} was denied by an admin`,
            capability,
            requestId,
          };
        }
        return {
          ok: false,
          code: "permission_denied",
          message: `request ${requestId} is still pending admin approval`,
          capability,
          requestId,
        };
      }
      return {
        ok: false,
        code: "permission_denied",
        message: payload.error ?? "permission denied",
        capability,
        requestId,
      };
    }
    if (status === 404) {
      return { ok: false, code: "not_found", message: payload.error ?? "channel or parent message not found" };
    }
    if (status === 400) {
      return { ok: false, code: "validation", message: payload.error ?? "invalid request" };
    }
    return { ok: false, code: "unknown", message: payload.error ?? `create thread failed: HTTP ${status}` };
  }

  async registerCommand(input: {
    name: string;
    description?: string;
    channelId?: string | null;
    argsSchema?: Record<string, unknown>;
  }): Promise<
    | { ok: true; commandId: string; requestId: string }
    | { ok: false; code: "validation" | "permission_denied" | "unknown"; message: string }
  > {
    const { status, body } = await this.call<{
      commandId?: string;
      requestId?: string;
      error?: string;
      code?: string;
    }>("POST", "/v1/commands", {
      name: input.name,
      description: input.description ?? null,
      channelId: input.channelId ?? null,
      argsSchema: input.argsSchema ?? {},
    });
    const payload = body as {
      commandId?: string;
      requestId?: string;
      error?: string;
      code?: string;
    };
    if (
      (status === 200 || status === 201) &&
      typeof payload.commandId === "string" &&
      typeof payload.requestId === "string"
    ) {
      return { ok: true, commandId: payload.commandId, requestId: payload.requestId };
    }
    if (status === 400) {
      return { ok: false, code: "validation", message: payload.error ?? "invalid request" };
    }
    if (status === 403) {
      return { ok: false, code: "permission_denied", message: payload.error ?? "permission denied" };
    }
    return { ok: false, code: "unknown", message: payload.error ?? `register command failed: HTTP ${status}` };
  }

  async listCommands(channelId?: string | null): Promise<
    Array<{
      id: string;
      orgId: string;
      channelId: string | null;
      name: string;
      ownerActorId: string;
      description: string | null;
      argsSchema: Record<string, unknown>;
      status: "pending" | "active" | "disabled";
      permissionRequestId: string | null;
      createdAt: string;
    }>
  > {
    const suffix = channelId ? `?channelId=${encodeURIComponent(channelId)}` : "";
    const { status, body } = await this.call<{
      commands: Array<{
        id: string;
        orgId: string;
        channelId: string | null;
        name: string;
        ownerActorId: string;
        description: string | null;
        argsSchema: Record<string, unknown>;
        status: "pending" | "active" | "disabled";
        permissionRequestId: string | null;
        createdAt: string;
      }>;
    }>("GET", `/v1/commands${suffix}`);
    if (status !== 200) throw new Error(`listCommands failed ${status}: ${JSON.stringify(body)}`);
    return (body as { commands: Array<any> }).commands;
  }

  async listMessages(streamId: string, afterSeq = 0): Promise<MlMessage[]> {
    const { status, body } = await this.call<{ messages: MlMessage[] }>(
      "GET",
      `/v1/streams/${streamId}/messages?afterSeq=${afterSeq}&limit=50`,
    );
    if (status !== 200) throw new Error(`listMessages failed ${status}: ${JSON.stringify(body)}`);
    return (body as { messages: MlMessage[] }).messages;
  }

  async listStreamEvents(
    streamId: string,
    fromSeq = 0,
  ): Promise<
    Array<{
      id: string;
      type: string;
      streamSeq: number | null;
      createdAt: string;
      payload: Record<string, unknown>;
    }>
  > {
    const { status, body } = await this.call<{
      events: Array<{
        id: string;
        type: string;
        streamSeq: number | null;
        createdAt: string;
        payload: Record<string, unknown>;
      }>;
    }>("GET", `/v1/streams/${streamId}/subscribe?fromSeq=${fromSeq}`);
    if (status !== 200) throw new Error(`listStreamEvents failed ${status}: ${JSON.stringify(body)}`);
    return (body as { events: Array<any> }).events;
  }

  async listThreads(
    channelId: string,
  ): Promise<
    Array<{
      id: string;
      parentMessageId: string;
      createdAt: string;
      visibility: "private" | "public";
    }>
  > {
    const { status, body } = await this.call<{
      threads: Array<{
        id: string;
        parentMessageId: string;
        createdAt: string;
        visibility: "private" | "public";
      }>;
    }>("GET", `/v1/channels/${channelId}/threads`);
    if (status !== 200) throw new Error(`listThreads failed ${status}: ${JSON.stringify(body)}`);
    return (body as { threads: Array<any> }).threads;
  }

  async openPermissionRequest(
    action: string,
    resourceType: string,
    resourceId: string | null,
    context: Record<string, unknown> = {},
  ): Promise<string | undefined> {
    try {
      const { status, body } = await this.call<{ requestId: string }>("POST", "/v1/permission-requests", {
        action,
        resourceType,
        resourceId,
        context,
      });
      if (status === 200 && typeof (body as { requestId: string }).requestId === "string") {
        return (body as { requestId: string }).requestId;
      }
    } catch {
      // swallow — callers can proceed without a requestId
    }
    return undefined;
  }
}
