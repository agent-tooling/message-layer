import { randomUUID } from "node:crypto";
import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { MessageLayerApiClient, type MessagePart } from "./api-client.js";
import type { KernelConfig, KernelState, KernelStatus, PendingApproval } from "./types.js";

export class AgentKernel {
  private session: AgentSession | undefined;
  private client: MessageLayerApiClient;
  private adminClient: MessageLayerApiClient;

  private _status: KernelStatus = "idle";
  private _pendingApprovals: PendingApproval[] = [];
  private _unsubscribe: (() => void) | undefined;

  /** Accumulated text delta per message (keyed by message id or timestamp) */
  private _textAccumulator = new Map<string, string>();

  constructor(private readonly config: KernelConfig) {
    this.client = new MessageLayerApiClient(config.baseUrl, config.agentPrincipal);
    this.adminClient = new MessageLayerApiClient(config.baseUrl, config.adminPrincipal);
  }

  get state(): KernelState {
    return {
      status: this._status,
      model: this.session?.model,
      pendingApprovals: [...this._pendingApprovals],
      sessionId: this.session?.sessionId,
    };
  }

  async init(): Promise<void> {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const cwd = this.config.cwd ?? process.cwd();

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      extensionFactories: [
        (pi) => {
          // Intercept every tool call for permission gate
          pi.on("tool_call", async (event) => {
            const { toolName, toolCallId } = event;
            const args = (event as unknown as { args: unknown }).args;

            const capability = `tool:execute:${toolName}`;
            const granted = await this.checkToolGrant(capability);
            if (granted) {
              return undefined; // allow
            }

            // Create permission request and suspend
            const requestId = await this.requestToolPermission(toolName, toolCallId, args);

            // Persist approval_request to the stream
            await this.appendParts(
              [{ type: "approval_request", payload: { requestId, toolName, toolCallId, args } }],
              `approval-req-${requestId}`,
            );

            const approved = await this.waitForApproval(requestId, toolName, toolCallId, args);

            if (!approved) {
              // Persist the denial
              await this.appendParts(
                [{ type: "approval_response", payload: { requestId, approved: false } }],
                `approval-resp-${requestId}`,
              );
              return { block: true, reason: `Tool '${toolName}' was denied by user` };
            }

            await this.appendParts(
              [{ type: "approval_response", payload: { requestId, approved: true } }],
              `approval-resp-${requestId}`,
            );
            return undefined; // allow
          });
        },
      ],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      model: this.config.model,
      tools: createCodingTools(cwd),
      cwd,
      sessionManager: SessionManager.inMemory(),
      authStorage,
      modelRegistry,
      resourceLoader,
    });

    this.session = session;
    this._unsubscribe = session.subscribe((event) => void this.handleSessionEvent(event));
    this._status = "idle";
  }

  private async handleSessionEvent(event: AgentSessionEvent): Promise<void> {
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        this._status = "running";
        break;
      case "agent_end":
      case "turn_end":
        if (this._pendingApprovals.length === 0) {
          this._status = "idle";
        }
        break;
      case "message_update":
        await this.onMessageUpdate(event);
        break;
      case "tool_execution_end":
        await this.onToolExecutionEnd(event);
        break;
    }
  }

  private messageKey(event: Extract<AgentSessionEvent, { type: "message_update" }>): string {
    // Use the message's timestamp as a stable key within a turn
    const msg = event.message;
    return String((msg as unknown as { timestamp?: number }).timestamp ?? randomUUID());
  }

  private async onMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): Promise<void> {
    const e = event.assistantMessageEvent;

    if (e.type === "text_delta") {
      const key = this.messageKey(event);
      this._textAccumulator.set(key, (this._textAccumulator.get(key) ?? "") + e.delta);
      return;
    }

    if (e.type === "done" || e.type === "error") {
      const key = this.messageKey(event);
      const accumulatedText = this._textAccumulator.get(key) ?? "";
      this._textAccumulator.delete(key);

      const parts: MessagePart[] = [];
      if (accumulatedText) {
        parts.push({ type: "text", payload: { text: accumulatedText } });
      }

      // Collect tool calls from the message content
      const msg = event.message;
      const content = (msg as unknown as { content?: unknown[] }).content ?? [];
      for (const c of content) {
        const block = c as { type?: string; toolCallId?: string; toolName?: string; input?: unknown };
        if (block.type === "toolCall" && block.toolCallId && block.toolName) {
          parts.push({
            type: "tool_call",
            payload: { toolCallId: block.toolCallId, toolName: block.toolName, args: block.input },
          });
        }
      }

      if (parts.length > 0) {
        await this.appendParts(parts, `msg-${key}`);
      }
    }
  }

  private async onToolExecutionEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): Promise<void> {
    const { toolCallId, toolName, result, isError } = event;
    const content: string =
      typeof result === "string"
        ? result
        : Array.isArray(result)
          ? result.map((c: unknown) => (typeof c === "object" && c !== null && "text" in c ? (c as { text: string }).text : "[binary]")).join("\n")
          : JSON.stringify(result);

    await this.appendParts(
      [{ type: "tool_result", payload: { toolCallId, toolName, content, isError } }],
      `tool-result-${toolCallId}`,
    );
  }

  private async appendParts(parts: MessagePart[], idempotencyKeySuffix: string): Promise<void> {
    try {
      await this.client.appendMessage({
        streamId: this.config.streamId,
        streamType: this.config.streamType,
        parts,
        idempotencyKey: `kernel-${this.config.agentPrincipal.actorId}-${idempotencyKeySuffix}`,
      });
    } catch (err) {
      console.error("[AgentKernel] appendParts error:", err);
    }
  }

  private async checkToolGrant(capability: string): Promise<boolean> {
    if (this.config.agentPrincipal.scopes.includes(capability)) {
      return true;
    }
    return this.adminClient.hasGrant(this.config.agentPrincipal.actorId, capability);
  }

  private async requestToolPermission(toolName: string, _toolCallId: string, _args: unknown): Promise<string> {
    const result = await this.client.createPermissionRequest({
      action: `tool:execute:${toolName}`,
      resourceType: "tool",
      resourceId: toolName,
    });
    return result.requestId;
  }

  private waitForApproval(requestId: string, toolName: string, toolCallId: string, args: unknown): Promise<boolean> {
    this._status = "waiting_approval";
    return new Promise<boolean>((resolve) => {
      this._pendingApprovals.push({ requestId, toolName, toolCallId, args, requestedAt: new Date().toISOString(), resolve });
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async prompt(text: string): Promise<void> {
    if (!this.session) throw new Error("kernel not initialised; call init() first");
    await this.appendParts([{ type: "text", payload: { text } }], `human-${Date.now()}`);
    await this.session.prompt(text);
  }

  async steer(text: string): Promise<void> {
    if (!this.session) throw new Error("kernel not initialised; call init() first");
    await this.session.steer(text);
  }

  async followUp(text: string): Promise<void> {
    if (!this.session) throw new Error("kernel not initialised; call init() first");
    await this.session.followUp(text);
  }

  async abort(): Promise<void> {
    await this.session?.abort();
    this._status = "idle";
  }

  async approve(requestId: string, notes = ""): Promise<void> {
    const idx = this._pendingApprovals.findIndex((a) => a.requestId === requestId);
    if (idx === -1) throw new Error(`no pending approval for requestId=${requestId}`);
    const [approval] = this._pendingApprovals.splice(idx, 1);
    await this.adminClient.resolvePermissionRequest(requestId, true, notes);
    approval.resolve(true);
    if (this._pendingApprovals.length === 0 && this._status === "waiting_approval") {
      this._status = "running";
    }
  }

  async deny(requestId: string, notes = "denied by user"): Promise<void> {
    const idx = this._pendingApprovals.findIndex((a) => a.requestId === requestId);
    if (idx === -1) throw new Error(`no pending approval for requestId=${requestId}`);
    const [approval] = this._pendingApprovals.splice(idx, 1);
    await this.adminClient.resolvePermissionRequest(requestId, false, notes);
    approval.resolve(false);
    if (this._pendingApprovals.length === 0 && this._status === "waiting_approval") {
      this._status = "running";
    }
  }

  async setModel(modelIdOrPattern: string): Promise<boolean> {
    if (!this.session) throw new Error("kernel not initialised; call init() first");
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    // Support "provider/id" format or partial id match
    let model = (() => {
      if (modelIdOrPattern.includes("/")) {
        const [provider, id] = modelIdOrPattern.split("/", 2);
        return modelRegistry.find(provider, id);
      }
      return modelRegistry.getAll().find((m) => m.id === modelIdOrPattern || m.id.includes(modelIdOrPattern));
    })();
    if (!model) return false;
    await this.session.setModel(model);
    return true;
  }

  async cycleModel(): Promise<string | undefined> {
    if (!this.session) throw new Error("kernel not initialised; call init() first");
    const result = await this.session.cycleModel();
    return result?.model ? `${result.model.provider}/${result.model.id}` : undefined;
  }

  async availableModels(): Promise<Array<{ provider: string; id: string; name: string }>> {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const models = await modelRegistry.getAvailable();
    return models.map((m) => ({ provider: m.provider, id: m.id, name: (m as unknown as { name?: string }).name ?? m.id }));
  }

  onOutput(cb: (text: string) => void): () => void {
    if (!this.session) throw new Error("kernel not initialised; call init() first");
    return this.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        cb(event.assistantMessageEvent.delta);
      }
    });
  }

  dispose(): void {
    this._unsubscribe?.();
    this.session?.dispose();
    this._status = "disposed";
    for (const approval of this._pendingApprovals) {
      approval.resolve(false);
    }
    this._pendingApprovals = [];
  }
}
