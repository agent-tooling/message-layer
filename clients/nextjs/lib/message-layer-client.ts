/**
 * Typed HTTP client for the message-layer API.
 * Works both in the browser (relative /api/proxy) and in Next.js API routes (direct baseUrl).
 */

export type MessagePartType =
  | "text"
  | "tool_call"
  | "tool_result"
  | "artifact"
  | "approval_request"
  | "approval_response";

export interface MessagePart {
  index: number;
  type: MessagePartType;
  payload: Record<string, unknown>;
}

export interface MessageRecord {
  id: string;
  streamSeq: number;
  actorId: string;
  createdAt: string;
  parts: MessagePart[];
}

export interface PermissionRequest {
  requestId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  createdAt: string;
}

export interface Principal {
  actorId: string;
  orgId: string;
  scopes: string[];
  provider: string;
}

export class MessageLayerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly principal: Principal,
  ) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-principal": JSON.stringify(this.principal),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const text = await res.text();
    let payload: unknown;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(payload)}`);
    return payload as T;
  }

  async listMessages(streamId: string, afterSeq = 0, limit = 50): Promise<MessageRecord[]> {
    const result = await this.request<{ messages: MessageRecord[] }>(
      "GET",
      `/v1/streams/${streamId}/messages?afterSeq=${afterSeq}&limit=${limit}`,
    );
    return result.messages;
  }

  async appendMessage(
    streamId: string,
    streamType: "channel" | "thread",
    parts: Array<{ type: MessagePartType; payload: Record<string, unknown> }>,
    idempotencyKey: string,
  ): Promise<{ messageId: string; streamSeq: number; idempotent: boolean }> {
    return this.request("POST", "/v1/messages", { streamId, streamType, parts, idempotencyKey });
  }

  async listOpenPermissionRequests(actorId?: string): Promise<PermissionRequest[]> {
    const qs = actorId ? `?actorId=${actorId}` : "";
    const result = await this.request<{ requests: PermissionRequest[] }>("GET", `/v1/permission-requests${qs}`);
    return result.requests;
  }

  async resolvePermissionRequest(requestId: string, approve: boolean, notes = ""): Promise<void> {
    await this.request("POST", `/v1/permission-requests/${requestId}/resolve`, { approve, notes });
  }

  async createOrg(name: string): Promise<{ orgId: string }> {
    return this.request("POST", "/v1/orgs", { name });
  }

  async createActor(orgId: string, actorType: "human" | "agent" | "app", displayName: string): Promise<{ actorId: string }> {
    return this.request("POST", "/v1/actors", { orgId, actorType, displayName });
  }

  async createChannel(name: string): Promise<{ channelId: string }> {
    return this.request("POST", "/v1/channels", { name });
  }

  async createGrant(actorId: string, resourceType: string, resourceId: string | null, capability: string): Promise<{ grantId: string }> {
    return this.request("POST", "/v1/grants", { actorId, resourceType, resourceId, capability });
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { cache: "no-store" });
      return res.ok;
    } catch {
      return false;
    }
  }
}
