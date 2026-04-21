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
  if (!opts.orgId) {
    throw new Error(
      "missing org id — pass `--org-id <id>` on the command line or set MESSAGE_LAYER_ORG_ID in the environment",
    );
  }

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
        provider: "poet-agent",
      };
      saveState({ orgId: opts.orgId, actorId: principal.actorId, provider: principal.provider, createdAt: new Date().toISOString() });
      return { principal, client, reused: false };
    }
    if (status.status === "denied") {
      throw new Error(
        `agent join request ${join.requestId} was denied${status.note ? `: ${status.note}` : ""}.`,
      );
    }
    throw new Error(
      `agent join request ${join.requestId} is pending admin approval. Resolve it in /admin/agents, then restart the poet.`,
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
    `agent join request ${payload.requestId} submitted. Approve it in /admin/agents, then restart the poet.`,
  );
}
