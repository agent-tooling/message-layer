import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MessageLayerClient, type Principal } from "./ml.js";

const STATE_DIR = resolve(".data");
const STATE_FILE = resolve(STATE_DIR, "poet-state.json");

type PoetState = {
  orgId: string;
  actorId: string;
  provider: string;
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

  let actorId: string;
  try {
    actorId = await client.createActor(opts.orgId, "agent", opts.displayName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/org not found/i.test(message)) {
      throw new Error(
        `org ${opts.orgId} not found on ${opts.baseUrl}. Did the core server restart? It runs PGlite in-memory by default, so its org catalog is reset on every boot. Open the Next.js app so it recreates the org, then re-run the poet with the fresh --org-id.`,
      );
    }
    throw error;
  }
  const principal: Principal = { actorId, orgId: opts.orgId, scopes: [], provider: "poet-agent" };
  saveState({ orgId: opts.orgId, actorId, provider: principal.provider, createdAt: new Date().toISOString() });
  return { principal, client, reused: false };
}
