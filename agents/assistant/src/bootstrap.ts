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
  if (!opts.orgId) throw new Error("missing org id");
  const client = new MessageLayerClient(opts.baseUrl);
  const cached = loadState();
  if (cached && cached.orgId === opts.orgId) {
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
  const appOrigin = new URL(opts.appUrl).origin;
  const join = loadJoinRequestState();
  if (join && join.orgId === opts.orgId) {
    const poll = await fetch(
      `${appOrigin}/api/team/agents/join-requests/${join.requestId}?secret=${encodeURIComponent(join.requestSecret)}`,
      { cache: "no-store" },
    );
    const status = (await poll.json()) as {
      status?: "open" | "approved" | "denied";
      actorId?: string | null;
      note?: string | null;
    };
    if (status.status === "approved" && status.actorId) {
      const principal: Principal = {
        actorId: status.actorId,
        orgId: opts.orgId,
        scopes: [],
        provider: "assistant-agent",
      };
      saveState({
        orgId: opts.orgId,
        actorId: principal.actorId,
        provider: principal.provider,
        createdAt: new Date().toISOString(),
      });
      return { principal, client, reused: false };
    }
    if (status.status === "denied") {
      throw new Error(
        `agent join request ${join.requestId} was denied${status.note ? `: ${status.note}` : ""}.`,
      );
    }
    throw new Error(
      `agent join request ${join.requestId} is pending admin approval. Resolve it in /admin/agents, then restart the assistant.`,
    );
  }

  const request = await fetch(`${appOrigin}/api/team/agents/join-requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: opts.displayName, orgId: opts.orgId }),
  });
  const payload = (await request.json()) as {
    requestId?: string;
    requestSecret?: string;
    error?: string;
  };
  if (!request.ok || !payload.requestId || !payload.requestSecret) {
    throw new Error(payload.error ?? `failed to create agent join request (${request.status})`);
  }
  saveJoinRequestState({
    requestId: payload.requestId,
    requestSecret: payload.requestSecret,
    orgId: opts.orgId,
    displayName: opts.displayName,
    createdAt: new Date().toISOString(),
  });
  throw new Error(
    `agent join request ${payload.requestId} submitted. Approve it in /admin/agents, then restart the assistant.`,
  );
}
