import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
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

function readTeamClientOrgId(dbPath: string): string | null {
  const fullPath = resolve(dbPath);
  if (!existsSync(fullPath)) return null;
  const db = new Database(fullPath, { readonly: true });
  try {
    const row = db
      .prepare<[string], { value: string }>("SELECT value FROM app_settings WHERE key = ?")
      .get("default_org_id");
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

/**
 * Verify the stored actor still exists in the message-layer server. Relevant
 * because the default dev config runs PGlite in `memory://server` — restarting
 * the server wipes every org + actor we previously created.
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
 *   1. Reuse the saved state if it still points at a live actor.
 *   2. Otherwise read the default org id from the Next.js team-client.db
 *      and mint a fresh `agent` actor in it.
 * The agent deliberately boots with **no** scopes so the permission flow
 * kicks in the first time it tries to create #poems or post into it.
 */
export async function bootstrapAgent(opts: {
  baseUrl: string;
  teamDbPath: string;
  displayName: string;
}): Promise<BootstrapResult> {
  const client = new MessageLayerClient(opts.baseUrl);

  const cached = loadState();
  if (cached) {
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

  const orgId = readTeamClientOrgId(opts.teamDbPath);
  if (!orgId) {
    throw new Error(
      `cannot find default_org_id in ${opts.teamDbPath}. Start the Next.js client (pnpm run client:nextjs) and sign in once so it bootstraps an org, then restart the poet.`,
    );
  }

  const actorId = await client.createActor(orgId, "agent", opts.displayName);
  const principal: Principal = { actorId, orgId, scopes: [], provider: "poet-agent" };
  saveState({ orgId, actorId, provider: principal.provider, createdAt: new Date().toISOString() });
  return { principal, client, reused: false };
}
