import { randomUUID } from "node:crypto";
import {
  MessageLayerClient,
  type MessageLayerClientOptions,
  type AppendMessageInput,
  type ArtifactRecord,
  type Channel,
  type ChannelMember,
  type CreateGrantInput,
  type GrantRecord,
  type MemoryHit,
  type MemoryUnit,
  type OrgMember,
  type PermissionRequest,
  type ResolveOptions,
  type SearchHit,
  type SearchSuggestion,
  type Thread,
  type WebhookSubscription,
  type RegisteredCommand,
} from "message-layer/sdk";
import { env } from "@/lib/env";
import {
  getSetting,
  getUserActorMap,
  getUserIdByActorId,
  getUserRole,
  hasConsumedInvite,
  setSetting,
  setUserActorMap,
  setUserRole,
  type UserRole,
} from "@/lib/app-db";

export type MlPrincipal = {
  actorId: string;
  orgId: string;
  scopes: string[];
  provider: string;
};

// Re-export SDK types that routes rely on
export type {
  RegisteredCommand as MlRegisteredCommand,
  ArtifactRecord as MlArtifactRecord,
  Channel,
  ChannelMember,
  GrantRecord as ActorEffectiveGrant,
  MemoryHit as MlMemoryHit,
  MemoryUnit as MlMemoryUnit,
  OrgMember,
  PermissionRequest as PermissionRequestRow,
  ResolveOptions,
  SearchHit as MlSearchHit,
  SearchSuggestion as MlSearchSuggestion,
  Thread,
  WebhookSubscription as MlWebhookSubscription,
};

export type MlMessageRecord = {
  id: string;
  streamSeq: number;
  actorId: string;
  createdAt: string;
  redacted?: boolean;
  redactedAt?: string | null;
  parts: Array<{ type: string; payload: Record<string, unknown> }>;
};

export type MlAuditRow = {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  prevHash: string | null;
  eventHash: string;
  createdAt: string;
};

// ── Principal + role management ────────────────────────────────────────────

type MlSessionUser = {
  id: string;
  email: string;
  name: string | null;
};

type MlResourceType = "org" | "channel" | "thread";
type RoleGrantTemplate = {
  capability: string;
  resourceType: MlResourceType;
  resourceId: string | null;
};

const bootstrapScopes = ["channel:create", "grant:create"];
const orgPlaceholder = "$org";
const roleScopes: Record<UserRole, string[]> = {
  owner: ["audit:read"],
  admin: ["audit:read"],
  member: [],
};

const roleTemplates: Record<UserRole, RoleGrantTemplate[]> = {
  owner: [
    { capability: "message:append", resourceType: "channel", resourceId: null },
    { capability: "message:append", resourceType: "thread", resourceId: null },
    { capability: "thread:create", resourceType: "channel", resourceId: null },
    { capability: "channel:create", resourceType: "org", resourceId: orgPlaceholder },
    { capability: "grant:create", resourceType: "org", resourceId: orgPlaceholder },
    { capability: "channel:admin", resourceType: "channel", resourceId: null },
  ],
  admin: [
    { capability: "message:append", resourceType: "channel", resourceId: null },
    { capability: "message:append", resourceType: "thread", resourceId: null },
    { capability: "thread:create", resourceType: "channel", resourceId: null },
    { capability: "channel:create", resourceType: "org", resourceId: orgPlaceholder },
    { capability: "grant:create", resourceType: "org", resourceId: orgPlaceholder },
    { capability: "channel:admin", resourceType: "channel", resourceId: null },
  ],
  member: [
    { capability: "message:append", resourceType: "channel", resourceId: null },
    { capability: "message:append", resourceType: "thread", resourceId: null },
    { capability: "thread:create", resourceType: "channel", resourceId: null },
  ],
};

// Hoist dedup map onto globalThis to survive Next.js hot-reload chunk splits
type InflightMap = Map<string, Promise<MlPrincipal>>;
const globalScope = globalThis as typeof globalThis & {
  __mlInflightPrincipals?: InflightMap;
};
const inFlightPrincipalResolutions: InflightMap =
  globalScope.__mlInflightPrincipals ?? new Map<string, Promise<MlPrincipal>>();
globalScope.__mlInflightPrincipals = inFlightPrincipalResolutions;

function mlClient(principal?: MlPrincipal): MessageLayerClient {
  return new MessageLayerClient({
    baseUrl: env.MESSAGE_LAYER_BASE_URL,
    principal: principal as MessageLayerClientOptions["principal"],
    fetch: (input, init) =>
      fetch(input as RequestInfo, { ...(init as RequestInit), cache: "no-store" }),
  });
}

function resolveRoleResourceId(resourceId: string | null, orgId: string): string | null {
  return resourceId === orgPlaceholder ? orgId : resourceId;
}

function scopesForRole(role: UserRole): string[] {
  return roleScopes[role];
}

async function revokeAllActorGrants(principal: MlPrincipal, actorId: string): Promise<void> {
  await mlClient(principal).revokeAllGrantsForActor(actorId, "role reconciliation");
}

async function applyRoleGrants(input: {
  grantor: MlPrincipal;
  actorId: string;
  orgId: string;
  role: UserRole;
}): Promise<void> {
  await revokeAllActorGrants(input.grantor, input.actorId);
  const client = mlClient(input.grantor);
  const template = roleTemplates[input.role];
  for (const grant of template) {
    await client.createGrant({
      actorId: input.actorId,
      resourceType: grant.resourceType,
      resourceId: resolveRoleResourceId(grant.resourceId, input.orgId),
      capability: grant.capability,
    } as CreateGrantInput);
  }
}

async function reconcileUserRole(input: {
  userId: string;
  actorId: string;
  orgId: string;
  role: UserRole;
}): Promise<void> {
  const grantor = await ensureBootstrapPrincipal(input.orgId);
  await applyRoleGrants({ grantor, actorId: input.actorId, orgId: input.orgId, role: input.role });
  setUserRole(input.userId, input.role);
}

function resolveRole(input: string | null | undefined): UserRole {
  if (input === "owner" || input === "admin" || input === "member") return input;
  return "member";
}

export function parseHumanRoleInput(input: string | null | undefined): UserRole | null {
  if (input === "owner" || input === "admin" || input === "member") return input;
  return null;
}

async function createOrg(name: string): Promise<string> {
  const { orgId } = await mlClient().createOrg(name);
  return orgId;
}

async function ensureOrg(): Promise<string> {
  const existing = getSetting("default_org_id");
  if (existing) return existing;
  const workspaceName = getSetting("workspace_name") ?? env.DEFAULT_ORG_NAME;
  const orgId = await createOrg(workspaceName);
  setSetting("default_org_id", orgId);
  return orgId;
}

async function ensureDefaultChannel(principal: MlPrincipal): Promise<string> {
  const existing = getSetting("default_channel_id");
  if (existing) return existing;
  const { channelId } = await mlClient(principal).createChannel(env.DEFAULT_CHANNEL_NAME, "public");
  setSetting("default_channel_id", channelId);
  return channelId;
}

async function createActor(
  orgId: string,
  displayName: string,
  actorType: "human" | "agent" | "app",
): Promise<string> {
  const { actorId } = await mlClient().createActor({ orgId, displayName, actorType });
  return actorId;
}

async function ensureBootstrapPrincipal(orgId: string): Promise<MlPrincipal> {
  const bootstrapActorIdKey = "bootstrap_actor_id";
  const bootstrapActorOrgKey = "bootstrap_actor_org_id";
  const existingActorId = getSetting(bootstrapActorIdKey);
  const existingOrgId = getSetting(bootstrapActorOrgKey);
  let actorId = existingActorId;
  if (!actorId || existingOrgId !== orgId) {
    actorId = await createActor(orgId, "Bootstrap System", "app");
    setSetting(bootstrapActorIdKey, actorId);
    setSetting(bootstrapActorOrgKey, orgId);
  }
  return { actorId, orgId, scopes: bootstrapScopes, provider: "bootstrap" };
}

export async function ensureUserPrincipal(user: MlSessionUser): Promise<MlPrincipal> {
  const cached = inFlightPrincipalResolutions.get(user.id);
  if (cached) return cached;

  const pending = (async (): Promise<MlPrincipal> => {
    const existing = getUserActorMap(user.id);
    if (existing) {
      const firstUserId = getSetting("first_user_id");
      const desiredRole = resolveRole(
        getUserRole(user.id) ?? (firstUserId === user.id ? "owner" : "member"),
      );
      if (!getUserRole(user.id)) {
        await reconcileUserRole({
          userId: user.id,
          actorId: existing.actor_id,
          orgId: existing.org_id,
          role: desiredRole,
        });
      }
      const principal: MlPrincipal = {
        actorId: existing.actor_id,
        orgId: existing.org_id,
        scopes: scopesForRole(desiredRole),
        provider: "better-auth",
      };
      try {
        await mlClient(principal).listChannels();
        return principal;
      } catch (error) {
        const message = (error as Error).message;
        if (!message.includes("actor is not in org")) throw error;
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
      if (!message.includes("FOREIGN KEY constraint failed")) throw error;
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

    const desiredRole = resolveRole(
      getUserRole(user.id) ??
        (getSetting("first_user_id") === user.id ? "owner" : "member"),
    );
    const principal: MlPrincipal = {
      actorId,
      orgId,
      scopes: scopesForRole(desiredRole),
      provider: "better-auth",
    };
    await reconcileUserRole({ userId: user.id, actorId, orgId, role: desiredRole });
    await ensureDefaultChannel(await ensureBootstrapPrincipal(orgId));
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
  const syntheticPrincipal = await ensureBootstrapPrincipal(orgId);
  const current = getSetting("default_channel_id");
  if (current && current.length > 0) return current;
  return ensureDefaultChannel(syntheticPrincipal);
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
  await mlClient(principal).createGrant({
    actorId: input.agentActorId,
    resourceType: input.resourceType as CreateGrantInput["resourceType"],
    resourceId: input.resourceId,
    capability: input.capability,
  });
}

export async function checkActorCapability(
  principal: MlPrincipal,
  actorId: string,
  capability: string,
): Promise<boolean> {
  return mlClient(principal).checkCapability(actorId, capability);
}

export async function canManageRoles(principal: MlPrincipal): Promise<boolean> {
  if (principal.scopes.includes("grant:create")) return true;
  return checkActorCapability(principal, principal.actorId, "grant:create");
}

export async function setActorRole(actorId: string, role: UserRole): Promise<void> {
  const userId = getUserIdByActorId(actorId);
  if (!userId) throw new Error("cannot set role for actor that is not mapped to a signed-in user");
  const actor = getUserActorMap(userId);
  if (!actor) throw new Error("user actor mapping not found");
  await reconcileUserRole({ userId, actorId: actor.actor_id, orgId: actor.org_id, role });
}

export async function setUserRoleForPrincipal(
  user: MlSessionUser,
  role: UserRole,
): Promise<MlPrincipal> {
  const principal = await ensureUserPrincipal(user);
  await reconcileUserRole({
    userId: user.id,
    actorId: principal.actorId,
    orgId: principal.orgId,
    role,
  });
  return { ...principal, scopes: scopesForRole(role) };
}

// ── API wrappers (thin delegators to SDK) ──────────────────────────────────

export async function listChannels(principal: MlPrincipal): Promise<Channel[]> {
  return mlClient(principal).listChannels();
}

export async function listMembers(principal: MlPrincipal): Promise<OrgMember[]> {
  return mlClient(principal).listMembers();
}

export async function listActors(principal: MlPrincipal) {
  return mlClient(principal).listActors();
}

export async function listMessages(
  principal: MlPrincipal,
  streamId: string,
  afterSeq = 0,
): Promise<MlMessageRecord[]> {
  const messages = await mlClient(principal).listMessages(streamId, { afterSeq, limit: 100 });
  return messages as MlMessageRecord[];
}

export async function redactMessage(
  principal: MlPrincipal,
  messageId: string,
  reason?: string,
): Promise<void> {
  return mlClient(principal).redactMessage(messageId, reason);
}

export async function addChannelMember(
  principal: MlPrincipal,
  channelId: string,
  actorId: string,
  role: string = "member",
): Promise<void> {
  return mlClient(principal).addChannelMember(channelId, actorId, role);
}

export async function removeChannelMember(
  principal: MlPrincipal,
  channelId: string,
  actorId: string,
): Promise<void> {
  return mlClient(principal).removeChannelMember(channelId, actorId);
}

export async function listChannelMembers(
  principal: MlPrincipal,
  channelId: string,
): Promise<ChannelMember[]> {
  return mlClient(principal).listChannelMembers(channelId);
}

export async function appendMessage(
  principal: MlPrincipal,
  input: Omit<AppendMessageInput, "idempotencyKey"> & { idempotencyKey?: string },
): Promise<void> {
  await mlClient(principal).appendMessage({
    ...input,
    idempotencyKey: input.idempotencyKey ?? `nextjs-team-client-${randomUUID()}`,
  });
}

export async function listCommands(
  principal: MlPrincipal,
  channelId?: string | null,
): Promise<RegisteredCommand[]> {
  const query = channelId ? `?channelId=${encodeURIComponent(channelId)}` : "";
  const response = await fetch(`${env.MESSAGE_LAYER_BASE_URL}/v1/commands${query}`, {
    method: "GET",
    headers: {
      "content-type": "application/json",
      "x-principal": JSON.stringify(principal),
    },
    cache: "no-store",
  });
  const payload = (await response.json()) as {
    commands?: RegisteredCommand[];
    error?: string;
  };
  if (!response.ok || !Array.isArray(payload.commands)) {
    throw new Error(payload.error ?? `listCommands failed: HTTP ${response.status}`);
  }
  return payload.commands;
}

export async function createChannel(principal: MlPrincipal, name: string): Promise<string> {
  const { channelId } = await mlClient(principal).createChannel(name, "public");
  return channelId;
}

export async function createPermissionRequest(
  principal: MlPrincipal,
  input: { action: string; resourceType: string; resourceId: string | null; context?: Record<string, unknown> },
): Promise<string> {
  const { requestId } = await mlClient(principal).createPermissionRequest(input);
  return requestId;
}

export async function listThreads(
  principal: MlPrincipal,
  channelId: string,
): Promise<Thread[]> {
  return mlClient(principal).listThreads(channelId);
}

export async function createThread(
  principal: MlPrincipal,
  channelId: string,
  parentMessageId: string,
  visibility: "public" | "private" = "public",
): Promise<string> {
  const { threadId } = await mlClient(principal).createThread(channelId, parentMessageId, visibility);
  return threadId;
}

export async function listPermissionRequests(
  principal: MlPrincipal,
  actorId?: string,
): Promise<PermissionRequest[]> {
  return mlClient(principal).listPermissionRequests(actorId);
}

export async function resolvePermissionRequest(
  principal: MlPrincipal,
  requestId: string,
  approve: boolean,
  options: ResolveOptions = {},
): Promise<void> {
  return mlClient(principal).resolvePermissionRequest(requestId, approve, options);
}

export async function revokeAllGrantsForActor(
  principal: MlPrincipal,
  actorId: string,
  reason?: string,
): Promise<{ revokedGrantIds: string[] }> {
  return mlClient(principal).revokeAllGrantsForActor(actorId, reason);
}

export async function listActorEffectiveGrants(
  principal: MlPrincipal,
  actorId: string,
): Promise<GrantRecord[]> {
  return mlClient(principal).listActorGrants(actorId);
}

export async function revokeGrant(principal: MlPrincipal, grantId: string): Promise<void> {
  return mlClient(principal).revokeGrant(grantId);
}

export async function fetchAuditRows(
  principal: MlPrincipal,
  options: { actorId?: string; limit?: number } = {},
): Promise<MlAuditRow[]> {
  const rows = await mlClient(principal).fetchAuditRows(options);
  return rows as MlAuditRow[];
}

export async function registerArtifact(
  principal: MlPrincipal,
  input: {
    streamId: string;
    streamType: "channel" | "thread";
    filename: string;
    contentType: string;
    content: Buffer;
    sha256?: string;
  },
): Promise<ArtifactRecord> {
  return mlClient(principal).registerArtifact({
    ...input,
    content: input.content.toString("base64"),
  });
}

export async function listStreamArtifacts(
  principal: MlPrincipal,
  streamId: string,
): Promise<ArtifactRecord[]> {
  return mlClient(principal).listStreamArtifacts(streamId);
}

export async function listMemory(
  principal: MlPrincipal,
  streamId: string,
): Promise<MemoryUnit[]> {
  return mlClient(principal).listMemory(streamId);
}

export async function promoteMemory(
  principal: MlPrincipal,
  memoryId: string,
  summary?: string,
): Promise<MemoryUnit> {
  return mlClient(principal).promoteMemory(memoryId, summary);
}

export async function searchMemory(
  principal: MlPrincipal,
  query: string,
  options?: { streamId?: string; limit?: number },
): Promise<{ query: string; hits: MemoryHit[] }> {
  return mlClient(principal).searchMemory(query, options);
}

export async function searchEntities(
  principal: MlPrincipal,
  query: string,
  options?: {
    entityTypes?: Array<"actor" | "channel" | "thread" | "message" | "memory">;
    streamId?: string;
    actorType?: "human" | "agent" | "app";
    limit?: number;
  },
): Promise<{ query: string; hits: SearchHit[] }> {
  return mlClient(principal).search(query, options);
}

export async function searchSuggest(
  principal: MlPrincipal,
  query: string,
  options?: { limit?: number },
): Promise<{ query: string; suggestions: SearchSuggestion[] }> {
  return mlClient(principal).searchSuggest(query, options);
}

export async function listWebhookSubscriptions(
  principal: MlPrincipal,
): Promise<WebhookSubscription[]> {
  return mlClient(principal).listWebhookSubscriptions();
}
