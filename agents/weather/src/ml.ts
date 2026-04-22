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
  | "approval_response"
  | "ui";
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

  async listChannels(): Promise<MlChannel[]> {
    const { status, body } = await this.call<{ channels: MlChannel[] }>("GET", "/v1/channels");
    if (status !== 200) throw new Error(`listChannels failed ${status}: ${JSON.stringify(body)}`);
    return (body as { channels: MlChannel[] }).channels;
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
    if (status === 400) return { ok: false, code: "validation", message: payload.error ?? "invalid request" };
    if (status === 403) {
      return { ok: false, code: "permission_denied", message: payload.error ?? "permission denied" };
    }
    return { ok: false, code: "unknown", message: payload.error ?? `register command failed: HTTP ${status}` };
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

  async createThread(
    channelId: string,
    parentMessageId: string,
    visibility: "public" | "private" = "public",
  ): Promise<
    | { ok: true; threadId: string }
    | {
        ok: false;
        code: "permission_denied" | "validation" | "not_found" | "unknown";
        message: string;
        requestId?: string;
        capability?: string;
      }
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
      return {
        ok: false,
        code: "permission_denied",
        message: payload.error ?? "permission denied",
        capability: payload.capability ?? "thread:create",
        requestId: payload.requestId,
      };
    }
    if (status === 404) {
      return { ok: false, code: "not_found", message: payload.error ?? "channel or parent message not found" };
    }
    if (status === 400) return { ok: false, code: "validation", message: payload.error ?? "invalid request" };
    return { ok: false, code: "unknown", message: payload.error ?? `create thread failed: HTTP ${status}` };
  }

  async appendParts(opts: {
    streamId: string;
    streamType: "channel" | "thread";
    parts: MlPart[];
    idempotencyKey?: string;
  }): Promise<MlAppendResult> {
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
      idempotencyKey: opts.idempotencyKey ?? `weather-parts-${randomUUID()}`,
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
    if (status === 404) return { ok: false, code: "not_found", message: b.error ?? "stream not found" };
    return {
      ok: false,
      code: "unknown",
      message: b.error ?? `append failed: HTTP ${status}`,
    };
  }
}
