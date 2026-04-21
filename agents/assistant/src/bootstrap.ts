import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MessageLayerClient, type Principal } from "./ml.js";

const STATE_DIR = resolve(".data");
const STATE_FILE = resolve(STATE_DIR, "assistant-state.json");

type AssistantState = {
  orgId: string;
  actorId: string;
  provider: string;
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

  const actorId = await client.createActor(opts.orgId, "agent", opts.displayName);
  const principal: Principal = {
    actorId,
    orgId: opts.orgId,
    scopes: [],
    provider: "assistant-agent",
  };
  saveState({
    orgId: opts.orgId,
    actorId,
    provider: principal.provider,
    createdAt: new Date().toISOString(),
  });
  return { principal, client, reused: false };
}
