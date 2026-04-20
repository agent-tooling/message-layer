import type { KernelPrincipal } from "./types.js";

export type MessagePart =
  | { type: "text"; payload: { text: string } }
  | { type: "tool_call"; payload: { toolCallId: string; toolName: string; args: unknown } }
  | { type: "tool_result"; payload: { toolCallId: string; toolName: string; content: string; isError: boolean } }
  | { type: "approval_request"; payload: { requestId: string; toolName: string; toolCallId: string; args: unknown } }
  | { type: "approval_response"; payload: { requestId: string; approved: boolean; notes?: string } }
  | { type: "artifact"; payload: Record<string, unknown> };

export interface AppendMessageInput {
  streamId: string;
  streamType: "channel" | "thread";
  parts: MessagePart[];
  idempotencyKey: string;
}

export interface PermissionRequestInput {
  action: string;
  resourceType: string;
  resourceId: string | null;
}

export class MessageLayerApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly principal: KernelPrincipal,
  ) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-principal": JSON.stringify(this.principal),
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let payload: unknown;
    try {
      payload = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      payload = text;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(payload)}`);
    }
    return payload as T;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
    });
    const text = await res.text();
    let payload: unknown;
    try {
      payload = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      payload = text;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(payload)}`);
    }
    return payload as T;
  }

  async appendMessage(input: AppendMessageInput): Promise<{ messageId: string; streamSeq: number; idempotent: boolean }> {
    return this.post("/v1/messages", input);
  }

  async createPermissionRequest(input: PermissionRequestInput): Promise<{ requestId: string }> {
    return this.post("/v1/permission-requests", input);
  }

  async resolvePermissionRequest(requestId: string, approve: boolean, notes = ""): Promise<void> {
    await this.post(`/v1/permission-requests/${requestId}/resolve`, { approve, notes });
  }

  async hasGrant(actorId: string, capability: string): Promise<boolean> {
    try {
      const result = await this.get<{ hasGrant: boolean }>(
        `/v1/grants/check?actorId=${actorId}&capability=${capability}`,
      );
      return result.hasGrant;
    } catch {
      return false;
    }
  }
}
