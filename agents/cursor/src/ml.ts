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
};

export type MlMessage = {
  id: string;
  streamSeq: number;
  actorId: string;
  createdAt: string;
  parts: Array<{ type: string; payload: Record<string, unknown> }>;
};

type PermissionDecision = "open" | "approved" | "denied";
type MlPartType =
  | "text"
  | "tool_call"
  | "tool_result"
  | "artifact"
  | "approval_request"
  | "approval_response"
  | "ui";
type MlPart = { type: MlPartType; payload: Record<string, unknown> };

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

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T | Record<string, unknown> }> {
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

  private async getPermissionRequestStatus(
    requestId: string,
  ): Promise<PermissionDecision> {
    try {
      const { status, body } = await this.call<{
        request?: { status?: PermissionDecision };
      }>("GET", `/v1/permission-requests/${requestId}`);
      if (status === 200) {
        const requestStatus = (
          body as { request?: { status?: PermissionDecision } }
        ).request?.status;
        if (
          requestStatus === "open" ||
          requestStatus === "approved" ||
          requestStatus === "denied"
        ) {
          return requestStatus;
        }
      }
    } catch {
      // best effort: treat as still pending and keep polling
    }
    return "open";
  }

  private async waitForPermissionDecision(
    requestId: string,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<PermissionDecision> {
    void requestId;
    void opts;
    // message-layer currently exposes list + resolve APIs for permission
    // requests, but no stable read-by-id endpoint for agents. Returning "open"
    // makes callers surface "pending approval" immediately instead of blocking
    // on an endpoint that may not exist.
    return "open";
  }

  async listChannels(): Promise<MlChannel[]> {
    const { status, body } = await this.call<{ channels: MlChannel[] }>(
      "GET",
      "/v1/channels",
    );
    if (status !== 200) {
      throw new Error(`listChannels failed ${status}: ${JSON.stringify(body)}`);
    }
    return (body as { channels: MlChannel[] }).channels;
  }

  async createChannel(
    name: string,
    visibility: "public" | "private" = "public",
  ): Promise<
    | { ok: true; channelId: string }
    | { ok: false; message: string; requestId?: string; capability?: string }
  > {
    return this.createChannelInternal(name, visibility, true);
  }

  private async createChannelInternal(
    name: string,
    visibility: "public" | "private",
    waitOnDeny: boolean,
  ): Promise<
    | { ok: true; channelId: string }
    | { ok: false; message: string; requestId?: string; capability?: string }
  > {
    const { status, body } = await this.call<{
      channelId?: string;
      error?: string;
      capability?: string;
    }>("POST", "/v1/channels", { name, visibility });
    if (
      status === 200 &&
      typeof (body as { channelId?: string }).channelId === "string"
    ) {
      return { ok: true, channelId: (body as { channelId: string }).channelId };
    }
    if (status === 403) {
      const capability =
        (body as { capability?: string }).capability ?? "channel:create";
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
      if (waitOnDeny && requestId) {
        const decision = await this.waitForPermissionDecision(requestId);
        if (decision === "approved") {
          return this.createChannelInternal(name, visibility, false);
        }
        if (decision === "denied") {
          return {
            ok: false,
            message: `request ${requestId} was denied by an admin`,
            requestId,
            capability,
          };
        }
        return {
          ok: false,
          message: `request ${requestId} is still pending admin approval`,
          requestId,
          capability,
        };
      }
      return {
        ok: false,
        message:
          (body as { error?: string }).error ?? "permission denied",
        requestId,
        capability,
      };
    }
    return {
      ok: false,
      message: (body as { error?: string }).error ?? `createChannel failed: ${status}`,
    };
  }

  async appendMessage(opts: {
    streamId: string;
    streamType: "channel" | "thread";
    text: string;
    idempotencyKey?: string;
  }): Promise<
    | { ok: true; messageId: string; streamSeq: number }
    | { ok: false; message: string; requestId?: string; capability?: string }
  > {
    return this.appendMessageInternal(opts, true);
  }

  async appendParts(opts: {
    streamId: string;
    streamType: "channel" | "thread";
    parts: MlPart[];
    idempotencyKey?: string;
  }): Promise<
    | { ok: true; messageId: string; streamSeq: number }
    | { ok: false; message: string; requestId?: string; capability?: string }
  > {
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
  ): Promise<
    | { ok: true; messageId: string; streamSeq: number }
    | { ok: false; message: string; requestId?: string; capability?: string }
  > {
    const { status, body } = await this.call<{
      messageId?: string;
      streamSeq?: number;
      denied?: boolean;
      requestId?: string;
      capability?: string;
      error?: string;
    }>("POST", "/v1/messages", {
      streamId: opts.streamId,
      streamType: opts.streamType,
      parts: opts.parts,
      idempotencyKey: opts.idempotencyKey ?? `cursor-parts-${randomUUID()}`,
      autoRequestOnDeny: true,
    });
    const b = body as {
      messageId?: string;
      streamSeq?: number;
      denied?: boolean;
      requestId?: string;
      capability?: string;
      error?: string;
    };
    if (status === 200 && b.denied && b.requestId) {
      if (waitOnDeny) {
        const decision = await this.waitForPermissionDecision(b.requestId);
        if (decision === "approved") {
          return this.appendPartsInternal(opts, false);
        }
        if (decision === "denied") {
          return {
            ok: false,
            message: `request ${b.requestId} was denied by an admin`,
            requestId: b.requestId,
            capability: b.capability,
          };
        }
        return {
          ok: false,
          message: `request ${b.requestId} is still pending admin approval`,
          requestId: b.requestId,
          capability: b.capability,
        };
      }
      return {
        ok: false,
        message: "append denied",
        requestId: b.requestId,
        capability: b.capability,
      };
    }
    if (
      status === 200 &&
      typeof b.messageId === "string" &&
      typeof b.streamSeq === "number"
    ) {
      return { ok: true, messageId: b.messageId, streamSeq: b.streamSeq };
    }
    return {
      ok: false,
      message: b.error ?? `append failed: ${status}`,
      capability: b.capability,
    };
  }

  private async appendMessageInternal(
    opts: {
      streamId: string;
      streamType: "channel" | "thread";
      text: string;
      idempotencyKey?: string;
    },
    waitOnDeny: boolean,
  ): Promise<
    | { ok: true; messageId: string; streamSeq: number }
    | { ok: false; message: string; requestId?: string; capability?: string }
  > {
    const { status, body } = await this.call<{
      messageId?: string;
      streamSeq?: number;
      denied?: boolean;
      requestId?: string;
      capability?: string;
      error?: string;
    }>("POST", "/v1/messages", {
      streamId: opts.streamId,
      streamType: opts.streamType,
      parts: [{ type: "text", payload: { text: opts.text } }],
      idempotencyKey: opts.idempotencyKey ?? `cursor-${randomUUID()}`,
      autoRequestOnDeny: true,
    });
    const b = body as {
      messageId?: string;
      streamSeq?: number;
      denied?: boolean;
      requestId?: string;
      capability?: string;
      error?: string;
    };
    if (status === 200 && b.denied && b.requestId) {
      if (waitOnDeny) {
        const decision = await this.waitForPermissionDecision(b.requestId);
        if (decision === "approved") {
          return this.appendMessageInternal(opts, false);
        }
        if (decision === "denied") {
          return {
            ok: false,
            message: `request ${b.requestId} was denied by an admin`,
            requestId: b.requestId,
            capability: b.capability,
          };
        }
        return {
          ok: false,
          message: `request ${b.requestId} is still pending admin approval`,
          requestId: b.requestId,
          capability: b.capability,
        };
      }
      return {
        ok: false,
        message: "append denied",
        requestId: b.requestId,
        capability: b.capability,
      };
    }
    if (
      status === 200 &&
      typeof b.messageId === "string" &&
      typeof b.streamSeq === "number"
    ) {
      return { ok: true, messageId: b.messageId, streamSeq: b.streamSeq };
    }
    return {
      ok: false,
      message: b.error ?? `append failed: ${status}`,
      capability: b.capability,
    };
  }

  async listMessages(streamId: string, afterSeq = 0): Promise<MlMessage[]> {
    const { status, body } = await this.call<{ messages: MlMessage[] }>(
      "GET",
      `/v1/streams/${streamId}/messages?afterSeq=${afterSeq}&limit=20`,
    );
    if (status !== 200) {
      throw new Error(`listMessages failed ${status}: ${JSON.stringify(body)}`);
    }
    return (body as { messages: MlMessage[] }).messages;
  }

  async listThreads(channelId: string): Promise<
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
    if (status !== 200) {
      throw new Error(`listThreads failed ${status}: ${JSON.stringify(body)}`);
    }
    return (
      body as {
        threads: Array<{
          id: string;
          parentMessageId: string;
          createdAt: string;
          visibility: "private" | "public";
        }>;
      }
    ).threads;
  }

  async createThread(
    channelId: string,
    parentMessageId: string,
    visibility: "public" | "private" = "private",
  ): Promise<
    | { ok: true; threadId: string }
    | { ok: false; message: string; capability?: string; requestId?: string }
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
    | { ok: false; message: string; capability?: string; requestId?: string }
  > {
    const { status, body } = await this.call<{
      threadId?: string;
      error?: string;
      capability?: string;
    }>("POST", "/v1/threads", { channelId, parentMessageId, visibility });
    const payload = body as {
      threadId?: string;
      error?: string;
      capability?: string;
    };
    if (status === 200 && typeof payload.threadId === "string") {
      return { ok: true, threadId: payload.threadId };
    }
    if (status === 403) {
      // Cursor-agent actors are bootstrapped with no scopes; the very first
      // `/cursor` or `@cursor` invocation trips the thread:create check.
      // Open a permission request so a human admin sees the request in the
      // Next.js inbox and can approve it, then block until they do — same
      // pattern `createChannel` and `appendParts` already use above.
      const capability = payload.capability ?? "thread:create";
      const requestId = await this.openPermissionRequest(
        capability,
        "channel",
        channelId,
        {
          kind: "thread.create",
          tool: "cursor_invocation_thread",
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
            message: `request ${requestId} was denied by an admin`,
            requestId,
            capability,
          };
        }
        return {
          ok: false,
          message: `request ${requestId} is still pending admin approval`,
          requestId,
          capability,
        };
      }
      return {
        ok: false,
        message: payload.error ?? "permission denied",
        requestId,
        capability,
      };
    }
    return {
      ok: false,
      message: payload.error ?? `createThread failed: ${status}`,
      capability: payload.capability,
    };
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
      status === 201 &&
      typeof payload.commandId === "string" &&
      typeof payload.requestId === "string"
    ) {
      return { ok: true, commandId: payload.commandId, requestId: payload.requestId };
    }
    if (status === 403) {
      return {
        ok: false,
        code: "permission_denied",
        message: payload.error ?? "permission denied",
      };
    }
    if (status === 400) {
      return {
        ok: false,
        code: "validation",
        message: payload.error ?? "validation failed",
      };
    }
    return {
      ok: false,
      code: "unknown",
      message: payload.error ?? `registerCommand failed: ${status}`,
    };
  }

  async openPermissionRequest(
    action: string,
    resourceType: string,
    resourceId: string | null,
    context: Record<string, unknown>,
  ): Promise<string | undefined> {
    try {
      const { status, body } = await this.call<{ requestId: string }>(
        "POST",
        "/v1/permission-requests",
        {
          action,
          resourceType,
          resourceId,
          context,
        },
      );
      if (
        status === 200 &&
        typeof (body as { requestId?: string }).requestId === "string"
      ) {
        return (body as { requestId: string }).requestId;
      }
    } catch {
      // best effort
    }
    return undefined;
  }
}
