import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { getSetting, getUserActorMap, hasConsumedInvite, setSetting, setUserActorMap } from "@/lib/app-db";

export type MlPrincipal = {
  actorId: string;
  orgId: string;
  scopes: string[];
  provider: string;
};

type MlSessionUser = {
  id: string;
  email: string;
  name: string | null;
};

const adminScopes = [
  "channel:create",
  "thread:create",
  "message:append",
  "grant:create",
];
const inFlightPrincipalResolutions = new Map<string, Promise<MlPrincipal>>();

async function mlRequest<T>(
  path: string,
  options: { method?: string; principal?: MlPrincipal; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.principal) {
    headers["x-principal"] = JSON.stringify(options.principal);
  }
  const response = await fetch(`${env.MESSAGE_LAYER_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
  });
  const text = await response.text();
  let payload: unknown = {};
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(`message-layer ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

async function createOrg(name: string): Promise<string> {
  const created = await mlRequest<{ orgId: string }>("/v1/orgs", {
    method: "POST",
    body: { name },
  });
  return created.orgId;
}

async function ensureOrg(): Promise<string> {
  const existing = getSetting("default_org_id");
  if (existing) {
    return existing;
  }
  const orgId = await createOrg(env.DEFAULT_ORG_NAME);
  setSetting("default_org_id", orgId);
  return orgId;
}

async function ensureDefaultChannel(principal: MlPrincipal): Promise<string> {
  const existing = getSetting("default_channel_id");
  if (existing) {
    return existing;
  }
  const created = await mlRequest<{ channelId: string }>("/v1/channels", {
    method: "POST",
    principal,
    body: { name: env.DEFAULT_CHANNEL_NAME, visibility: "public" },
  });
  setSetting("default_channel_id", created.channelId);
  return created.channelId;
}

async function createActor(orgId: string, displayName: string, actorType: "human" | "agent" | "app"): Promise<string> {
  const created = await mlRequest<{ actorId: string }>("/v1/actors", {
    method: "POST",
    body: { orgId, actorType, displayName },
  });
  return created.actorId;
}

export async function ensureUserPrincipal(user: MlSessionUser): Promise<MlPrincipal> {
  const cached = inFlightPrincipalResolutions.get(user.id);
  if (cached) {
    return cached;
  }

  const pending = (async (): Promise<MlPrincipal> => {
    const existing = getUserActorMap(user.id);
    if (existing) {
      const principal: MlPrincipal = {
        actorId: existing.actor_id,
        orgId: existing.org_id,
        scopes: adminScopes,
        provider: "better-auth",
      };
      try {
        await listChannels(principal);
        return principal;
      } catch (error) {
        const message = (error as Error).message;
        if (!message.includes("actor is not in org")) {
          throw error;
        }
      }
    }

    const firstUserId = getSetting("first_user_id");
    if (!firstUserId) {
      setSetting("first_user_id", user.id);
    } else if (firstUserId !== user.id && !hasConsumedInvite(user.id)) {
      throw new Error("invite required before joining this workspace");
    }

    let orgId = await ensureOrg();
    let actorId: string;
    try {
      actorId = await createActor(orgId, user.name ?? user.email, "human");
    } catch (error) {
      const message = (error as Error).message;
      if (!message.includes("FOREIGN KEY constraint failed")) {
        throw error;
      }
      orgId = await createOrg(env.DEFAULT_ORG_NAME);
      setSetting("default_org_id", orgId);
      setSetting("default_channel_id", "");
      actorId = await createActor(orgId, user.name ?? user.email, "human");
    }

    setUserActorMap({
      user_id: user.id,
      actor_id: actorId,
      org_id: orgId,
      display_name: user.name ?? user.email,
      created_at: new Date().toISOString(),
    });

    const principal: MlPrincipal = {
      actorId,
      orgId,
      scopes: adminScopes,
      provider: "better-auth",
    };
    await ensureDefaultChannel(principal);
    return principal;
  })();

  inFlightPrincipalResolutions.set(user.id, pending);
  try {
    return await pending;
  } finally {
    inFlightPrincipalResolutions.delete(user.id);
  }
}

export async function getDefaultChannelId(): Promise<string> {
  const orgId = await ensureOrg();
  const syntheticPrincipal: MlPrincipal = {
    actorId: "bootstrap",
    orgId,
    scopes: adminScopes,
    provider: "bootstrap",
  };
  const current = getSetting("default_channel_id");
  if (current && current.length > 0) {
    return current;
  }
  const actorId = await createActor(orgId, "Bootstrap System", "app");
  const principal = { ...syntheticPrincipal, actorId };
  return ensureDefaultChannel(principal);
}

export async function createAgentActor(orgId: string, displayName: string): Promise<string> {
  return createActor(orgId, displayName, "agent");
}

export async function grantAgentCapability(input: {
  orgId: string;
  grantorActorId: string;
  agentActorId: string;
  resourceType: string;
  resourceId: string | null;
  capability: string;
}): Promise<void> {
  const principal: MlPrincipal = {
    actorId: input.grantorActorId,
    orgId: input.orgId,
    scopes: ["grant:create"],
    provider: "better-auth-agent",
  };
  await mlRequest("/v1/grants", {
    method: "POST",
    principal,
    body: {
      actorId: input.agentActorId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      capability: input.capability,
    },
  });
}

export async function listChannels(principal: MlPrincipal): Promise<Array<{ id: string; name: string; visibility: string }>> {
  const result = await mlRequest<{ channels: Array<{ id: string; name: string; visibility: string }> }>("/v1/channels", {
    principal,
  });
  return result.channels;
}

export async function listMembers(principal: MlPrincipal): Promise<Array<{ actorId: string; displayName: string; actorType: string }>> {
  const result = await mlRequest<{
    members: Array<{ actorId: string; displayName: string; actorType: string }>;
  }>("/v1/members", { principal });
  return result.members;
}

export async function listActors(
  principal: MlPrincipal,
): Promise<Array<{ actorId: string; displayName: string; actorType: string; createdAt: string }>> {
  const result = await mlRequest<{
    actors: Array<{ actorId: string; displayName: string; actorType: string; createdAt: string }>;
  }>("/v1/actors", { principal });
  return result.actors;
}

export async function listMessages(
  principal: MlPrincipal,
  streamId: string,
  afterSeq = 0,
): Promise<Array<{ id: string; streamSeq: number; actorId: string; createdAt: string; parts: Array<{ type: string; payload: Record<string, unknown> }> }>> {
  const result = await mlRequest<{
    messages: Array<{
      id: string;
      streamSeq: number;
      actorId: string;
      createdAt: string;
      parts: Array<{ type: string; payload: Record<string, unknown> }>;
    }>;
  }>(`/v1/streams/${streamId}/messages?afterSeq=${afterSeq}&limit=100`, { principal });
  return result.messages;
}

export async function appendMessage(
  principal: MlPrincipal,
  input: {
    streamId: string;
    streamType: "channel" | "thread";
    parts: Array<{ type: "text" | "artifact"; payload: Record<string, unknown> }>;
  },
): Promise<void> {
  await mlRequest("/v1/messages", {
    method: "POST",
    principal,
    body: {
      streamId: input.streamId,
      streamType: input.streamType,
      parts: input.parts,
      idempotencyKey: `nextjs-team-client-${randomUUID()}`,
    },
  });
}

export async function createChannel(principal: MlPrincipal, name: string): Promise<string> {
  const result = await mlRequest<{ channelId: string }>("/v1/channels", {
    method: "POST",
    principal,
    body: { name, visibility: "public" },
  });
  return result.channelId;
}

export async function listThreads(
  principal: MlPrincipal,
  channelId: string,
): Promise<Array<{ id: string; parentMessageId: string; visibility: string }>> {
  const result = await mlRequest<{ threads: Array<{ id: string; parentMessageId: string; visibility: string }> }>(
    `/v1/channels/${channelId}/threads`,
    { principal },
  );
  return result.threads;
}

export async function createThread(principal: MlPrincipal, channelId: string, parentMessageId: string): Promise<string> {
  const result = await mlRequest<{ threadId: string }>("/v1/threads", {
    method: "POST",
    principal,
    body: { channelId, parentMessageId, visibility: "private" },
  });
  return result.threadId;
}
