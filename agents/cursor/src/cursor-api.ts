const CURSOR_API_BASE = "https://api.cursor.com";

export type AgentStatus = "CREATING" | "RUNNING" | "FINISHED" | "FAILED" | "STOPPED";

export type AgentSource = {
  repository: string;
  ref?: string;
  prUrl?: string;
};

export type AgentTarget = {
  branchName?: string;
  url?: string;
  prUrl?: string;
  autoCreatePr: boolean;
  openAsCursorGithubApp: boolean;
  skipReviewerRequest: boolean;
  autoBranch?: boolean;
};

export type CursorAgent = {
  id: string;
  name: string;
  status: AgentStatus;
  source: AgentSource;
  target: AgentTarget;
  summary?: string;
  createdAt: string;
};

export type AgentMessage = {
  id: string;
  type: "user_message" | "assistant_message";
  text: string;
};

export type Artifact = {
  absolutePath: string;
  sizeBytes: number;
  updatedAt: string;
};

export type Repository = {
  owner: string;
  name: string;
  repository: string;
};

export type LaunchAgentOpts = {
  prompt: {
    text: string;
    images?: Array<{ data: string; dimension: { width: number; height: number } }>;
  };
  model?: string;
  source: {
    repository?: string;
    ref?: string;
    prUrl?: string;
  };
  target?: {
    autoCreatePr?: boolean;
    openAsCursorGithubApp?: boolean;
    skipReviewerRequest?: boolean;
    branchName?: string;
    autoBranch?: boolean;
  };
  webhook?: {
    url: string;
    secret?: string;
  };
};

export class CursorApiClient {
  private authHeader: string;

  constructor(apiKey: string) {
    this.authHeader = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${CURSOR_API_BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Cursor API ${method} ${path} → ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  getMe(): Promise<{ apiKeyName: string; createdAt: string; userEmail: string }> {
    return this.request("GET", "/v0/me");
  }

  listModels(): Promise<{ models: string[] }> {
    return this.request("GET", "/v0/models");
  }

  listRepositories(): Promise<{ repositories: Repository[] }> {
    return this.request("GET", "/v0/repositories");
  }

  listAgents(opts?: { limit?: number; cursor?: string; prUrl?: string }): Promise<{
    agents: CursorAgent[];
    nextCursor?: string;
  }> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.prUrl) params.set("prUrl", opts.prUrl);
    const qs = params.toString();
    return this.request("GET", `/v0/agents${qs ? `?${qs}` : ""}`);
  }

  getAgent(id: string): Promise<CursorAgent> {
    return this.request("GET", `/v0/agents/${id}`);
  }

  getConversation(id: string): Promise<{ id: string; messages: AgentMessage[] }> {
    return this.request("GET", `/v0/agents/${id}/conversation`);
  }

  getArtifacts(id: string): Promise<{ artifacts: Artifact[] }> {
    return this.request("GET", `/v0/agents/${id}/artifacts`);
  }

  downloadArtifact(id: string, path: string): Promise<{ url: string; expiresAt: string }> {
    return this.request("GET", `/v0/agents/${id}/artifacts/download?path=${encodeURIComponent(path)}`);
  }

  launchAgent(opts: LaunchAgentOpts): Promise<CursorAgent> {
    return this.request("POST", "/v0/agents", opts);
  }

  addFollowup(id: string, prompt: { text: string; images?: LaunchAgentOpts["prompt"]["images"] }): Promise<{ id: string }> {
    return this.request("POST", `/v0/agents/${id}/followup`, { prompt });
  }

  stopAgent(id: string): Promise<{ id: string }> {
    return this.request("POST", `/v0/agents/${id}/stop`);
  }

  deleteAgent(id: string): Promise<{ id: string }> {
    return this.request("DELETE", `/v0/agents/${id}`);
  }

  async waitForTerminal(
    id: string,
    opts: { pollMs?: number; timeoutMs?: number } = {},
  ): Promise<CursorAgent> {
    const pollMs = opts.pollMs ?? 5000;
    const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
    const deadline = Date.now() + timeoutMs;
    const terminal: AgentStatus[] = ["FINISHED", "FAILED", "STOPPED"];
    for (;;) {
      const agent = await this.getAgent(id);
      if (terminal.includes(agent.status)) return agent;
      if (Date.now() >= deadline) {
        throw new Error(`Cursor agent ${id} timed out after ${timeoutMs / 1000}s (status: ${agent.status})`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
