import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MessageLayerClient, type Principal } from "./ml.js";

const STATE_DIR = resolve(".data");
const STATE_FILE = resolve(STATE_DIR, "poet-state.json");
const JOIN_REQUEST_FILE = resolve(STATE_DIR, "poet-join-request.json");

type PoetState = {
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

function loadState(): PoetState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as PoetState;
  } catch {
    return null;
  }
}

function saveState(state: PoetState): void {
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

/**
 * Verify the stored actor still exists in the message-layer server. Relevant
 * because the default dev config runs PGlite in `memory://server` — restarting
 * the server wipes every org + actor we previously created, so a cached
 * principal from the last boot would start returning "actor is not in org".
 */
async function actorIsLive(client: MessageLayerClient, principal: Principal): Promise<boolean> {
  try {
    const scoped = client.withPrincipal(principal);
    await scoped.listChannels();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/actor is not in org|not in principal org|stream not found/i.test(message)) {
      return false;
    }
    // Anything else (e.g. network) is not a staleness signal — surface it.
    throw error;
  }
}

export type BootstrapResult = {
  principal: Principal;
  client: MessageLayerClient;
  reused: boolean;
};

/**
 * Resolve the agent's identity:
 *   1. Reuse the saved state when it still points at a live actor in the
 *      requested org.
 *   2. Otherwise mint a fresh `agent` actor in the supplied org id.
 *
 * The agent deliberately boots with **no** scopes so the permission flow
 * kicks in the first time it tries to create #poems or post into it.
 *
 * The org id is passed in by the caller (from a `--org-id` CLI flag or
 * `MESSAGE_LAYER_ORG_ID`) — we intentionally do NOT peek into the Next.js
 * client's SQLite. In practice, an operator onboarding a real agent knows
 * which org it belongs in; reading another app's DB would be a
 * boundary violation (and silently caches a stale id the moment the core
 * server restarts on `memory://`).
 */
export async function bootstrapAgent(opts: {
  baseUrl: string;
  appUrl: string;
  orgId: string;
  displayName: string;
}): Promise<BootstrapResult> {
  const client = new MessageLayerClient(opts.baseUrl);
  const appOrigin = new URL(opts.appUrl).origin;

  const resolveWorkspace = async (): Promise<{ orgId: string; hasWorkspace: boolean }> => {
    const setup = await fetch(`${appOrigin}/api/team/setup`, { cache: "no-store" });
    if (!setup.ok) {
      throw new Error(`failed to load workspace setup info (${setup.status})`);
    }
    const payload = (await setup.json()) as { hasWorkspace?: boolean; orgId?: string | null };
    const orgId = (payload.orgId ?? "").trim();
    return { orgId, hasWorkspace: payload.hasWorkspace === true };
  };

  const workspace = await resolveWorkspace();
  if (!workspace.hasWorkspace || !workspace.orgId) {
    throw new Error("workspace is not initialized yet. Open the Next.js app and complete setup.");
  }
  const targetOrgId = workspace.orgId;

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
        `[poet] waiting for admin approval on join request ${requestId} (polling every ${pollMs}ms)`,
      );
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };

  const join = loadJoinRequestState();
  if (join && join.orgId === targetOrgId) {
    const actorId = await waitForJoinApproval(join.requestId, join.requestSecret);
    const principal: Principal = {
      actorId,
      orgId: targetOrgId,
      scopes: [],
      provider: "poet-agent",
    };
    saveState({ orgId: targetOrgId, actorId: principal.actorId, provider: principal.provider, createdAt: new Date().toISOString() });
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
    provider: "poet-agent",
  };
  saveState({ orgId: joinOrgId, actorId: principal.actorId, provider: principal.provider, createdAt: new Date().toISOString() });
  return { principal, client, reused: false };
}
