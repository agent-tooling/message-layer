import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MessageLayerClient, type Principal } from "./ml.js";

const STATE_DIR = resolve(".data");
const STATE_FILE = resolve(STATE_DIR, "assistant-state.json");
const JOIN_REQUEST_FILE = resolve(STATE_DIR, "assistant-join-request.json");

type AssistantState = {
  orgId: string;
  actorId: string;
  provider: string;
  createdAt: string;
};

type JoinRequestState = {
  requestId: string;
  requestSecret: string;
  orgId: string;
  displayName: string;
  createdAt: string;
};

function loadState(): AssistantState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as AssistantState;
  } catch {
    return null;
  }
}

function saveState(state: AssistantState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadJoinRequestState(): JoinRequestState | null {
  if (!existsSync(JOIN_REQUEST_FILE)) return null;
  try {
    return JSON.parse(readFileSync(JOIN_REQUEST_FILE, "utf8")) as JoinRequestState;
  } catch {
    return null;
  }
}

function saveJoinRequestState(state: JoinRequestState): void {
  mkdirSync(dirname(JOIN_REQUEST_FILE), { recursive: true });
  writeFileSync(JOIN_REQUEST_FILE, JSON.stringify(state, null, 2));
}

async function actorIsLive(client: MessageLayerClient, principal: Principal): Promise<boolean> {
  try {
    await client.withPrincipal(principal).listChannels();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/actor is not in org|not in principal org/i.test(message)) return false;
    throw error;
  }
}

export async function bootstrapAgent(opts: {
  baseUrl: string;
  appUrl: string;
  orgId: string;
  displayName: string;
}): Promise<{ principal: Principal; client: MessageLayerClient; reused: boolean }> {
  const client = new MessageLayerClient(opts.baseUrl);
  const appOrigin = new URL(opts.appUrl).origin;

  const resolveWorkspace = async (): Promise<{ orgId: string; hasWorkspace: boolean }> => {
    const setup = await fetch(`${appOrigin}/api/team/setup`, { cache: "no-store" });
    if (!setup.ok) {
      throw new Error(`failed to load workspace setup info (${setup.status})`);
    }
    const payload = (await setup.json()) as { hasWorkspace?: boolean; orgId?: string | null };
    return {
      hasWorkspace: payload.hasWorkspace === true,
      orgId: (payload.orgId ?? "").trim(),
    };
  };

  const workspace = await resolveWorkspace();
  if (!workspace.hasWorkspace || !workspace.orgId) {
    throw new Error("workspace is not initialized yet. Open the Next.js app and complete setup.");
  }
  const targetOrgId = workspace.orgId;

  const waitForJoinApproval = async (requestId: string, requestSecret: string): Promise<string> => {
    const pollMs = Number(process.env.AGENT_JOIN_POLL_MS ?? "5000");
    for (;;) {
      const poll = await fetch(
        `${appOrigin}/api/team/agents/join-requests/${requestId}?secret=${encodeURIComponent(requestSecret)}`,
        { cache: "no-store" },
      );
      const status = (await poll.json()) as {
        status?: "open" | "approved" | "denied";
        actorId?: string | null;
        note?: string | null;
      };
      if (status.status === "approved" && status.actorId) {
        return status.actorId;
      }
      if (status.status === "denied") {
        throw new Error(
          `agent join request ${requestId} was denied${status.note ? `: ${status.note}` : ""}.`,
        );
      }
      console.log(
        `[assistant] waiting for admin approval on join request ${requestId} (polling every ${pollMs}ms)`,
      );
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };

  const cached = loadState();
  if (cached && cached.orgId === targetOrgId) {
    const principal: Principal = {
      actorId: cached.actorId,
      orgId: cached.orgId,
      scopes: [],
      provider: cached.provider,
    };
    if (await actorIsLive(client, principal)) {
      return { principal, client, reused: true };
    }
  }

  const join = loadJoinRequestState();
  if (join && join.orgId === targetOrgId) {
    const actorId = await waitForJoinApproval(join.requestId, join.requestSecret);
    const principal: Principal = {
      actorId,
      orgId: targetOrgId,
      scopes: [],
      provider: "assistant-agent",
    };
    saveState({
      orgId: targetOrgId,
      actorId: principal.actorId,
      provider: principal.provider,
      createdAt: new Date().toISOString(),
    });
    return { principal, client, reused: false };
  }

  const request = await fetch(`${appOrigin}/api/team/agents/join-requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: opts.displayName }),
  });
  const payload = (await request.json()) as {
    requestId?: string;
    requestSecret?: string;
    orgId?: string;
    error?: string;
  };
  if (!request.ok || !payload.requestId || !payload.requestSecret) {
    throw new Error(payload.error ?? `failed to create agent join request (${request.status})`);
  }
  const joinOrgId = (payload.orgId ?? targetOrgId).trim() || targetOrgId;
  saveJoinRequestState({
    requestId: payload.requestId,
    requestSecret: payload.requestSecret,
    orgId: joinOrgId,
    displayName: opts.displayName,
    createdAt: new Date().toISOString(),
  });
  const actorId = await waitForJoinApproval(payload.requestId, payload.requestSecret);
  const principal: Principal = {
    actorId,
    orgId: joinOrgId,
    scopes: [],
    provider: "assistant-agent",
  };
  saveState({
    orgId: joinOrgId,
    actorId: principal.actorId,
    provider: principal.provider,
    createdAt: new Date().toISOString(),
  });
  return { principal, client, reused: false };
}
