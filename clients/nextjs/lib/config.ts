/**
 * Runtime config resolved from environment variables.
 * Set these in .env.local for local development.
 */
export const ML_BASE_URL =
  process.env.NEXT_PUBLIC_MESSAGE_LAYER_URL ?? process.env.MESSAGE_LAYER_URL ?? "http://127.0.0.1:3000";

/** Dev principal used when no auth is configured */
export const DEV_PRINCIPAL = {
  actorId: process.env.MESSAGE_LAYER_ACTOR_ID ?? "dev-actor",
  orgId: process.env.MESSAGE_LAYER_ORG_ID ?? "dev-org",
  scopes: (process.env.MESSAGE_LAYER_SCOPES ?? "channel:create,message:append,grant:create").split(",").map((s) => s.trim()),
  provider: "nextjs-client",
};

export const DEFAULT_CHANNEL_ID = process.env.MESSAGE_LAYER_CHANNEL_ID ?? "";
export const AGENT_ACTOR_ID = process.env.MESSAGE_LAYER_AGENT_ACTOR_ID ?? "";
