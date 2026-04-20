import type { Api, Model } from "@mariozechner/pi-ai";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<Api>;

export interface KernelPrincipal {
  actorId: string;
  orgId: string;
  scopes: string[];
  provider: string;
}

export interface KernelConfig {
  /** Base URL of the message-layer HTTP server */
  baseUrl: string;
  /** Principal for the agent actor */
  agentPrincipal: KernelPrincipal;
  /** Principal with grant:create scope used to resolve permission requests */
  adminPrincipal: KernelPrincipal;
  /** The message-layer stream (channel or thread) the agent writes into */
  streamId: string;
  streamType: "channel" | "thread";
  /** Pi model to start with; undefined = Pi picks from available */
  model?: AnyModel;
  /** Working directory for Pi tools (defaults to process.cwd()) */
  cwd?: string;
}

export interface PendingApproval {
  requestId: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
  requestedAt: string;
  /** Resolve/reject the suspended tool execution */
  resolve: (approved: boolean) => void;
}

export type KernelStatus = "idle" | "running" | "waiting_approval" | "disposed";

export interface KernelState {
  status: KernelStatus;
  model: AnyModel | undefined;
  pendingApprovals: PendingApproval[];
  sessionId: string | undefined;
}
