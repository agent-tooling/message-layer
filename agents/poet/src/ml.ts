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
