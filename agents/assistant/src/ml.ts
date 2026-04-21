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
  | "approval_response";
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
      // best effort: treat as still pending and keep polling
    }
    return "open";
  }

  private async waitForPermissionDecision(
    requestId: string,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<PermissionDecision> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 2000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this.getPermissionRequestStatus(requestId);
      if (status === "approved" || status === "denied") return status;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return "open";
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
    const { status, body } = await this.call<{ channelId?: string; error?: string; capability?: string }>(
      "POST",
      "/v1/channels",
      { name, visibility },
    );
    if (status === 200 && typeof (body as { channelId?: string }).channelId === "string") {
      return { ok: true, channelId: (body as { channelId: string }).channelId };
    }
    if (status === 403) {
      const capability = (body as { capability?: string }).capability ?? "channel:create";
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
      return { ok: false, message: (body as { error?: string }).error ?? "permission denied", requestId, capability };
    }
    return { ok: false, message: (body as { error?: string }).error ?? `createChannel failed: ${status}` };
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
      idempotencyKey: opts.idempotencyKey ?? `assistant-parts-${randomUUID()}`,
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
      return { ok: false, message: "append denied", requestId: b.requestId, capability: b.capability };
    }
    if (status === 200 && typeof b.messageId === "string" && typeof b.streamSeq === "number") {
      return { ok: true, messageId: b.messageId, streamSeq: b.streamSeq };
    }
    return { ok: false, message: b.error ?? `append failed: ${status}`, capability: b.capability };
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
      idempotencyKey: opts.idempotencyKey ?? `assistant-${randomUUID()}`,
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
      return { ok: false, message: "append denied", requestId: b.requestId, capability: b.capability };
    }
    if (status === 200 && typeof b.messageId === "string" && typeof b.streamSeq === "number") {
      return { ok: true, messageId: b.messageId, streamSeq: b.streamSeq };
    }
    return { ok: false, message: b.error ?? `append failed: ${status}`, capability: b.capability };
  }

  async listMessages(streamId: string, afterSeq = 0): Promise<MlMessage[]> {
    const { status, body } = await this.call<{ messages: MlMessage[] }>(
      "GET",
      `/v1/streams/${streamId}/messages?afterSeq=${afterSeq}&limit=10`,
    );
    if (status !== 200) throw new Error(`listMessages failed ${status}: ${JSON.stringify(body)}`);
    return (body as { messages: MlMessage[] }).messages;
  }

  async openPermissionRequest(
    action: string,
    resourceType: string,
    resourceId: string | null,
    context: Record<string, unknown>,
  ): Promise<string | undefined> {
    try {
      const { status, body } = await this.call<{ requestId: string }>("POST", "/v1/permission-requests", {
        action,
        resourceType,
        resourceId,
        context,
      });
      if (status === 200 && typeof (body as { requestId?: string }).requestId === "string") {
        return (body as { requestId: string }).requestId;
      }
    } catch {
      // best effort
    }
    return undefined;
  }
}
