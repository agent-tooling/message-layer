import { randomUUID } from "node:crypto";
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
    {
      capability: "channel:create",
      resourceType: "org",
      resourceId: orgPlaceholder,
    },
    {
      capability: "grant:create",
      resourceType: "org",
      resourceId: orgPlaceholder,
    },
    { capability: "channel:admin", resourceType: "channel", resourceId: null },
  ],
  admin: [
    { capability: "message:append", resourceType: "channel", resourceId: null },
    { capability: "message:append", resourceType: "thread", resourceId: null },
    { capability: "thread:create", resourceType: "channel", resourceId: null },
    {
      capability: "channel:create",
      resourceType: "org",
      resourceId: orgPlaceholder,
    },
    {
      capability: "grant:create",
      resourceType: "org",
      resourceId: orgPlaceholder,
    },
    { capability: "channel:admin", resourceType: "channel", resourceId: null },
  ],
  member: [
    { capability: "message:append", resourceType: "channel", resourceId: null },
    { capability: "message:append", resourceType: "thread", resourceId: null },
    { capability: "thread:create", resourceType: "channel", resourceId: null },
  ],
};

// Next.js 16 / Turbopack can give each route handler chunk its own copy of
// this module in dev mode. A module-scoped Map therefore does not dedupe
// concurrent principal resolutions across different /api/team/* handlers,
// which caused `createActor` to run multiple times for the same user and
// leaked duplicate actor records into message-layer. Hoist the dedup map
// onto `globalThis` so every module instance shares the same lock table.
type InflightMap = Map<string, Promise<MlPrincipal>>;
const globalScope = globalThis as typeof globalThis & {
  __mlInflightPrincipals?: InflightMap;
};
const inFlightPrincipalResolutions: InflightMap =
  globalScope.__mlInflightPrincipals ?? new Map<string, Promise<MlPrincipal>>();
globalScope.__mlInflightPrincipals = inFlightPrincipalResolutions;

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
    throw new Error(
      `message-layer ${response.status}: ${JSON.stringify(payload)}`,
    );
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
  const workspaceName = getSetting("workspace_name") ?? env.DEFAULT_ORG_NAME;
  const orgId = await createOrg(workspaceName);
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

async function createActor(
  orgId: string,
  displayName: string,
  actorType: "human" | "agent" | "app",
): Promise<string> {
  const created = await mlRequest<{ actorId: string }>("/v1/actors", {
    method: "POST",
    body: { orgId, actorType, displayName },
  });
  return created.actorId;
}

async function createGrant(
  principal: MlPrincipal,
  input: {
    actorId: string;
    resourceType: MlResourceType;
    resourceId: string | null;
    capability: string;
  },
): Promise<void> {
  await mlRequest("/v1/grants", {
    method: "POST",
    principal,
    body: {
      actorId: input.actorId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      capability: input.capability,
    },
  });
}

async function revokeAllActorGrants(
  principal: MlPrincipal,
  actorId: string,
): Promise<void> {
  await mlRequest(`/v1/actors/${actorId}/revoke-grants`, {
    method: "POST",
    principal,
    body: { reason: "role reconciliation" },
  });
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
  return {
    actorId,
    orgId,
    scopes: bootstrapScopes,
    provider: "bootstrap",
  };
}

function resolveRole(input: string | null | undefined): UserRole {
  if (input === "owner" || input === "admin" || input === "member") {
    return input;
  }
  return "member";
}

export function parseHumanRoleInput(
  input: string | null | undefined,
): UserRole | null {
  if (input === "owner" || input === "admin" || input === "member") {
    return input;
  }
  return null;
}

function resolveRoleResourceId(
  resourceId: string | null,
  orgId: string,
): string | null {
  if (resourceId === orgPlaceholder) {
    return orgId;
  }
  return resourceId;
}

function scopesForRole(role: UserRole): string[] {
  return roleScopes[role];
}

async function applyRoleGrants(input: {
  grantor: MlPrincipal;
  actorId: string;
  orgId: string;
  role: UserRole;
}): Promise<void> {
  await revokeAllActorGrants(input.grantor, input.actorId);
  const template = roleTemplates[input.role];
  for (const grant of template) {
    await createGrant(input.grantor, {
      actorId: input.actorId,
      resourceType: grant.resourceType,
      resourceId: resolveRoleResourceId(grant.resourceId, input.orgId),
      capability: grant.capability,
    });
  }
}

async function reconcileUserRole(input: {
  userId: string;
  actorId: string;
  orgId: string;
  role: UserRole;
}): Promise<void> {
  const grantor = await ensureBootstrapPrincipal(input.orgId);
  await applyRoleGrants({
    grantor,
    actorId: input.actorId,
    orgId: input.orgId,
    role: input.role,
  });
  setUserRole(input.userId, input.role);
}

export async function ensureUserPrincipal(
  user: MlSessionUser,
): Promise<MlPrincipal> {
  const cached = inFlightPrincipalResolutions.get(user.id);
  if (cached) {
    return cached;
  }

  const pending = (async (): Promise<MlPrincipal> => {
    // Double-check under the inflight lock — guards against a race where
    // another request finished after our caller's first `getUserActorMap`
    // read but before this lock was acquired.
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
    await reconcileUserRole({
      userId: user.id,
      actorId,
      orgId,
      role: desiredRole,
    });
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
  if (current && current.length > 0) {
    return current;
  }
  return ensureDefaultChannel(syntheticPrincipal);
}

export async function createAgentActor(
  orgId: string,
  displayName: string,
): Promise<string> {
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

export async function checkActorCapability(
  principal: MlPrincipal,
  actorId: string,
  capability: string,
): Promise<boolean> {
  const encodedActorId = encodeURIComponent(actorId);
  const encodedCapability = encodeURIComponent(capability);
  const result = await mlRequest<{ hasGrant: boolean }>(
    `/v1/grants/check?actorId=${encodedActorId}&capability=${encodedCapability}`,
    { principal },
  );
  return result.hasGrant;
}

export async function canManageRoles(principal: MlPrincipal): Promise<boolean> {
  if (principal.scopes.includes("grant:create")) {
    return true;
  }
  return checkActorCapability(principal, principal.actorId, "grant:create");
}

export async function setActorRole(
  actorId: string,
  role: UserRole,
): Promise<void> {
  const userId = getUserIdByActorId(actorId);
  if (!userId) {
    throw new Error(
      "cannot set role for actor that is not mapped to a signed-in user",
    );
  }
  const actor = getUserActorMap(userId);
  if (!actor) {
    throw new Error("user actor mapping not found");
  }
  await reconcileUserRole({
    userId,
    actorId: actor.actor_id,
    orgId: actor.org_id,
    role,
  });
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
  return {
    ...principal,
    scopes: scopesForRole(role),
  };
}

export async function listChannels(
  principal: MlPrincipal,
): Promise<Array<{ id: string; name: string; visibility: string }>> {
  const result = await mlRequest<{
    channels: Array<{ id: string; name: string; visibility: string }>;
  }>("/v1/channels", {
    principal,
  });
  return result.channels;
}

export async function listMembers(
  principal: MlPrincipal,
): Promise<
  Array<{
    actorId: string;
    displayName: string;
    actorType: string;
    role: string;
  }>
> {
  const result = await mlRequest<{
    members: Array<{
      actorId: string;
      displayName: string;
      actorType: string;
      role: string;
    }>;
  }>("/v1/members", { principal });
  return result.members;
}

export async function listActors(
  principal: MlPrincipal,
): Promise<
  Array<{
    actorId: string;
    displayName: string;
    actorType: string;
    createdAt: string;
  }>
> {
  const result = await mlRequest<{
    actors: Array<{
      actorId: string;
      displayName: string;
      actorType: string;
      createdAt: string;
    }>;
  }>("/v1/actors", { principal });
  return result.actors;
}

export type MlMessageRecord = {
  id: string;
  streamSeq: number;
  actorId: string;
  createdAt: string;
  redacted?: boolean;
  redactedAt?: string | null;
  parts: Array<{ type: string; payload: Record<string, unknown> }>;
};

export async function listMessages(
  principal: MlPrincipal,
  streamId: string,
  afterSeq = 0,
): Promise<MlMessageRecord[]> {
  const result = await mlRequest<{ messages: MlMessageRecord[] }>(
    `/v1/streams/${streamId}/messages?afterSeq=${afterSeq}&limit=100`,
    { principal },
  );
  return result.messages;
}

export async function redactMessage(
  principal: MlPrincipal,
  messageId: string,
  reason?: string,
): Promise<void> {
  await mlRequest(`/v1/messages/${messageId}/redact`, {
    method: "POST",
    principal,
    body: { reason: reason ?? "" },
  });
}

export async function addChannelMember(
  principal: MlPrincipal,
  channelId: string,
  actorId: string,
  role: string = "member",
): Promise<void> {
  await mlRequest(`/v1/channels/${channelId}/members`, {
    method: "POST",
    principal,
    body: { actorId, role },
  });
}

export async function removeChannelMember(
  principal: MlPrincipal,
  channelId: string,
  actorId: string,
): Promise<void> {
  await mlRequest(`/v1/channels/${channelId}/members/${actorId}`, {
    method: "DELETE",
    principal,
  });
}

export async function listChannelMembers(
  principal: MlPrincipal,
  channelId: string,
): Promise<Array<{ actorId: string; role: string; createdAt: string }>> {
  const result = await mlRequest<{
    members: Array<{ actorId: string; role: string; createdAt: string }>;
  }>(`/v1/channels/${channelId}/members`, { principal });
  return result.members;
}

export async function appendMessage(
  principal: MlPrincipal,
  input: {
    streamId: string;
    streamType: "channel" | "thread";
    parts: Array<{
      type: "text" | "artifact";
      payload: Record<string, unknown>;
    }>;
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

export async function createChannel(
  principal: MlPrincipal,
  name: string,
): Promise<string> {
  const result = await mlRequest<{ channelId: string }>("/v1/channels", {
    method: "POST",
    principal,
    body: { name, visibility: "public" },
  });
  return result.channelId;
}

export async function createPermissionRequest(
  principal: MlPrincipal,
  input: {
    action: string;
    resourceType: string;
    resourceId: string | null;
    context?: Record<string, unknown>;
  },
): Promise<string> {
  const result = await mlRequest<{ requestId: string }>(
    "/v1/permission-requests",
    {
      method: "POST",
      principal,
      body: {
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        context: input.context ?? {},
      },
    },
  );
  return result.requestId;
}

export async function listThreads(
  principal: MlPrincipal,
  channelId: string,
): Promise<Array<{ id: string; parentMessageId: string; visibility: string }>> {
  const result = await mlRequest<{
    threads: Array<{ id: string; parentMessageId: string; visibility: string }>;
  }>(`/v1/channels/${channelId}/threads`, { principal });
  return result.threads;
}

export async function createThread(
  principal: MlPrincipal,
  channelId: string,
  parentMessageId: string,
  visibility: "public" | "private" = "public",
): Promise<string> {
  // Default to matching the channel's visibility. In this client all channels
  // are created as `public`, so making threads public preserves the
  // "derived data must never be more visible than its source" rule while
  // still letting every channel reader see the thread. Service-level
  // assertStreamReadable otherwise requires explicit channel membership
  // for private threads.
  const result = await mlRequest<{ threadId: string }>("/v1/threads", {
    method: "POST",
    principal,
    body: { channelId, parentMessageId, visibility },
  });
  return result.threadId;
}

export type PermissionRequestRow = {
  requestId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  context: Record<string, unknown>;
  createdAt: string;
};

export type ResolveOptions = {
  notes?: string;
  expiresAt?: string | null;
  maxUses?: number | null;
};

export type MlAuditRow = {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  prevHash: string | null;
  eventHash: string;
  createdAt: string;
};

export async function listPermissionRequests(
  principal: MlPrincipal,
  actorId?: string,
): Promise<PermissionRequestRow[]> {
  const query = actorId ? `?actorId=${encodeURIComponent(actorId)}` : "";
  const result = await mlRequest<{ requests: PermissionRequestRow[] }>(
    `/v1/permission-requests${query}`,
    { principal },
  );
  return result.requests;
}

export async function resolvePermissionRequest(
  principal: MlPrincipal,
  requestId: string,
  approve: boolean,
  options: ResolveOptions = {},
): Promise<void> {
  await mlRequest(`/v1/permission-requests/${requestId}/resolve`, {
    method: "POST",
    principal,
    body: {
      approve,
      notes: options.notes ?? (approve ? "approved via UI" : "denied via UI"),
      expiresAt: options.expiresAt ?? null,
      maxUses: options.maxUses ?? null,
    },
  });
}

export async function revokeAllGrantsForActor(
  principal: MlPrincipal,
  actorId: string,
  reason?: string,
): Promise<{ revokedGrantIds: string[] }> {
  return mlRequest<{ revokedGrantIds: string[] }>(
    `/v1/actors/${actorId}/revoke-grants`,
    {
      method: "POST",
      principal,
      body: { reason: reason ?? "" },
    },
  );
}

export async function fetchAuditRows(
  principal: MlPrincipal,
  options: { actorId?: string; limit?: number } = {},
): Promise<MlAuditRow[]> {
  const params = new URLSearchParams();
  if (options.actorId) params.set("actorId", options.actorId);
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  const result = await mlRequest<{ rows: MlAuditRow[] }>(
    `/v1/audit/rows${qs ? `?${qs}` : ""}`,
    {
      principal,
    },
  );
  return result.rows;
}

// ── artifacts ──────────────────────────────────────────────────────────

export type MlArtifactRecord = {
  id: string;
  orgId: string;
  streamId: string;
  streamType: "channel" | "thread";
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  storageKind: string;
  createdByActorId: string;
  createdAt: string;
  deleted: boolean;
};

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
): Promise<MlArtifactRecord> {
  const result = await mlRequest<{ artifact: MlArtifactRecord }>(
    "/v1/artifacts",
    {
      method: "POST",
      principal,
      body: {
        streamId: input.streamId,
        streamType: input.streamType,
        filename: input.filename,
        contentType: input.contentType,
        contentBase64: input.content.toString("base64"),
        sha256: input.sha256,
      },
    },
  );
  return result.artifact;
}

export async function listStreamArtifacts(
  principal: MlPrincipal,
  streamId: string,
): Promise<MlArtifactRecord[]> {
  const result = await mlRequest<{ artifacts: MlArtifactRecord[] }>(
    `/v1/streams/${streamId}/artifacts`,
    { principal },
  );
  return result.artifacts;
}

// ── knowledge (scoped-knowledge plugin) ────────────────────────────────

export type MlKnowledgeEntry = {
  id: string;
  orgId: string;
  sourceStreamId: string;
  sourceStreamType: "channel" | "thread";
  sourceMessageId: string;
  sourceVisibility: "private" | "public";
  createdByActorId: string;
  text: string;
  promoted: boolean;
  promotedAt: string | null;
  promotedByActorId: string | null;
  promotionSummary: string | null;
  createdAt: string;
};

export async function listKnowledge(
  principal: MlPrincipal,
  streamId: string,
): Promise<MlKnowledgeEntry[]> {
  const result = await mlRequest<{ entries: MlKnowledgeEntry[] }>(
    `/v1/knowledge?streamId=${encodeURIComponent(streamId)}`,
    { principal },
  );
  return result.entries;
}

export async function promoteKnowledge(
  principal: MlPrincipal,
  entryId: string,
  summary?: string,
): Promise<MlKnowledgeEntry> {
  const result = await mlRequest<{ entry: MlKnowledgeEntry }>(
    `/v1/knowledge/${entryId}/promote`,
    { method: "POST", principal, body: { summary } },
  );
  return result.entry;
}

export type MlWebhookSubscription = {
  id: string;
  orgId: string;
  actorId: string;
  endpoint: string;
  eventTypes: string[];
  streamId: string | null;
  enabled: boolean;
  createdAt: string;
};

export async function listWebhookSubscriptions(
  principal: MlPrincipal,
): Promise<MlWebhookSubscription[]> {
  const result = await mlRequest<{ subscriptions: MlWebhookSubscription[] }>(
    "/v1/webhooks/subscriptions?includeDisabled=true",
    { principal },
  );
  return result.subscriptions;
}
