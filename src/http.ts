import { Hono, type Context } from "hono";
import { z } from "zod";
import type { MessageLayerService } from "./service.js";
import {
  NotFoundError,
  PermissionError,
  ValidationError,
  actorTypeSchema,
  messagePartSchema,
  principalSchema,
  streamTypeSchema,
  visibilitySchema,
  type Principal,
} from "./types.js";

const createOrgBody = z.object({ name: z.string().min(1) });
const createActorBody = z.object({
  orgId: z.string().min(1),
  actorType: actorTypeSchema,
  displayName: z.string().min(1),
});
const createChannelBody = z.object({
  name: z.string().min(1),
  visibility: visibilitySchema.optional(),
});
const createThreadBody = z.object({
  channelId: z.string().min(1),
  parentMessageId: z.string().min(1),
  visibility: visibilitySchema.optional(),
});
const appendMessageBody = z.object({
  streamId: z.string().min(1),
  streamType: streamTypeSchema,
  parts: z.array(messagePartSchema).min(1),
  idempotencyKey: z.string().min(1),
  autoRequestOnDeny: z.boolean().optional(),
});
const redactMessageBody = z.object({ reason: z.string().optional() });
const updateCursorBody = z.object({
  streamId: z.string().min(1),
  lastSeenSeq: z.number().int().nonnegative(),
  lastAckSeq: z.number().int().nonnegative(),
});
const createPermissionRequestBody = z.object({
  action: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.union([z.string(), z.null()]).optional(),
  context: z.record(z.unknown()).optional(),
});
const resolvePermissionRequestBody = z.object({
  approve: z.boolean(),
  notes: z.string().optional(),
  /** ISO-8601 timestamp; when set on an approve, the issued grant expires at this instant. */
  expiresAt: z.union([z.string(), z.null()]).optional(),
  /** Positive integer; `1` is the "approve once" case. `null` (or omitted) means unlimited. */
  maxUses: z.union([z.number().int().positive(), z.null()]).optional(),
});
const revokeAllGrantsBody = z.object({
  reason: z.string().optional(),
});
const createGrantBody = z.object({
  actorId: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.union([z.string(), z.null()]).optional(),
  capability: z.string().min(1),
  expiresAt: z.union([z.string(), z.null()]).optional(),
  constraints: z.record(z.unknown()).optional(),
  maxUses: z.union([z.number().int().positive(), z.null()]).optional(),
});
const channelMemberBody = z.object({
  actorId: z.string().min(1),
  role: z.string().optional(),
});
const clientBody = z.object({
  endpoint: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});
const registerArtifactBody = z.object({
  streamId: z.string().min(1),
  streamType: streamTypeSchema,
  filename: z.string().min(1),
  contentType: z.string().min(1),
  /**
   * Base64-encoded bytes. JSON-only API keeps the HTTP surface uniform; bulk
   * uploads that need streaming should call the service directly or front
   * this with a signed-URL workflow in a plugin.
   */
  contentBase64: z.string().min(1),
  sha256: z.string().optional(),
});

function parsePrincipal(headerValue: string | undefined): Principal | null {
  if (!headerValue) return null;
  try {
    const parsed = JSON.parse(headerValue);
    const result = principalSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function requirePrincipal(c: Context): { ok: true; principal: Principal } | { ok: false; response: Response } {
  const principal = parsePrincipal(c.req.header("x-principal"));
  if (!principal) {
    return { ok: false, response: c.json({ error: "missing or invalid principal" }, 401) };
  }
  return { ok: true, principal };
}

function handleError(c: Context, error: unknown): Response {
  if (error instanceof PermissionError) {
    return c.json({ error: error.message, code: error.code, capability: error.capability, resourceType: error.resourceType, resourceId: error.resourceId }, 403);
  }
  if (error instanceof NotFoundError) {
    return c.json({ error: error.message, code: error.code }, 404);
  }
  if (error instanceof ValidationError || error instanceof z.ZodError) {
    const msg = error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : error.message;
    return c.json({ error: msg, code: "VALIDATION" }, 400);
  }
  if (error instanceof SyntaxError) {
    return c.json({ error: "invalid json body", code: "VALIDATION" }, 400);
  }
  if (error instanceof Error) {
    return c.json({ error: error.message, code: "ERROR" }, 400);
  }
  return c.json({ error: "unexpected error", code: "ERROR" }, 500);
}

function encodeFilename(name: string): string {
  // Strip control characters / quotes to keep the Content-Disposition header
  // well-formed. Clients see the sanitized name; the raw name lives in the
  // artifact metadata.
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f"\\]/g, "_");
}

async function parseJsonBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new SyntaxError("invalid json body");
  }
  return schema.parse(raw);
}

export function createApp(service: MessageLayerService): Hono {
  const app = new Hono();

  // ── health ───────────────────────────────────────────────────────────────
  app.get("/health", (c) => c.json({ ok: true }));

  // ── orgs / actors (unauthenticated bootstrap) ────────────────────────────
  app.post("/v1/orgs", async (c) => {
    try {
      const body = await parseJsonBody(c, createOrgBody);
      const orgId = await service.createOrg(body.name);
      return c.json({ orgId });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.post("/v1/actors", async (c) => {
    try {
      const body = await parseJsonBody(c, createActorBody);
      const actorId = await service.createActor(body.orgId, body.actorType, body.displayName);
      return c.json({ actorId });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // ── authenticated routes ─────────────────────────────────────────────────
  const authed = (c: Context): { principal: Principal } | { response: Response } => {
    const result = requirePrincipal(c);
    return result.ok ? { principal: result.principal } : { response: result.response };
  };

  app.get("/v1/actors", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const actors = await service.listActorSummaries(auth.principal);
      return c.json({ actors });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/members", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const members = await service.listMembers(auth.principal);
      return c.json({ members });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // channels
  app.post("/v1/channels", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const body = await parseJsonBody(c, createChannelBody);
      const channelId = await service.createChannel(auth.principal, body.name, body.visibility ?? "private");
      return c.json({ channelId });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/channels", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const channels = await service.listChannels(auth.principal);
      return c.json({ channels });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.post("/v1/channels/:channelId/members", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const body = await parseJsonBody(c, channelMemberBody);
      await service.addChannelMember(auth.principal, c.req.param("channelId"), body.actorId, body.role ?? "member");
      return c.json({ ok: true });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.delete("/v1/channels/:channelId/members/:actorId", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      await service.removeChannelMember(auth.principal, c.req.param("channelId"), c.req.param("actorId"));
      return c.json({ ok: true });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/channels/:channelId/members", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const members = await service.listChannelMembers(auth.principal, c.req.param("channelId"));
      return c.json({ members });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // threads
  app.post("/v1/threads", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const body = await parseJsonBody(c, createThreadBody);
      const threadId = await service.createThread(auth.principal, body.channelId, body.parentMessageId, body.visibility ?? "private");
      return c.json({ threadId });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/channels/:channelId/threads", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const threads = await service.listThreads(auth.principal, c.req.param("channelId"));
      return c.json({ threads });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // messages
  app.post("/v1/messages", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const body = await parseJsonBody(c, appendMessageBody);
      const result = await service.appendMessage(auth.principal, body);
      return c.json(result);
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.post("/v1/messages/:messageId/redact", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const body = await parseJsonBody(c, redactMessageBody);
      await service.redactMessage(auth.principal, c.req.param("messageId"), body.reason ?? "");
      return c.json({ ok: true });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/streams/:streamId/messages", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const streamId = c.req.param("streamId");
      const afterSeq = Number(c.req.query("afterSeq") ?? "0");
      const limit = Number(c.req.query("limit") ?? "50");
      const messages = await service.listMessages(auth.principal, streamId, { afterSeq, limit });
      return c.json({ messages });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/streams/:streamId/subscribe", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const streamId = c.req.param("streamId");
      const fromSeq = Number(c.req.query("fromSeq") ?? "0");
      const events = await service.subscribe(auth.principal, streamId, { fromSeq });
      return c.json({ events });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // cursors
  app.post("/v1/cursors", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const body = await parseJsonBody(c, updateCursorBody);
      await service.updateCursor(auth.principal, body.streamId, body.lastSeenSeq, body.lastAckSeq);
      return c.json({ ok: true });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/streams/:streamId/cursor", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const cursor = await service.getCursor(auth.principal, c.req.param("streamId"));
      return c.json({ cursor });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // grants + permission requests
  app.post("/v1/grants", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const body = await parseJsonBody(c, createGrantBody);
      const grantId = await service.createGrant(
        auth.principal,
        body.actorId,
        body.resourceType,
        body.resourceId ?? null,
        body.capability,
        body.expiresAt ?? null,
        body.constraints ?? {},
        body.maxUses ?? null,
      );
      return c.json({ grantId });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.post("/v1/grants/:grantId/revoke", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      await service.revokeGrant(auth.principal, c.req.param("grantId"));
      return c.json({ ok: true });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/grants/check", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const actorId = c.req.query("actorId") ?? auth.principal.actorId;
      const capability = c.req.query("capability");
      if (!capability) {
        return c.json({ error: "capability query param required", code: "VALIDATION" }, 400);
      }
      const hasGrant = await service.checkGrant(auth.principal.orgId, actorId, capability);
      return c.json({ hasGrant });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.post("/v1/permission-requests", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const body = await parseJsonBody(c, createPermissionRequestBody);
      const requestId = await service.createPermissionRequest(
        auth.principal,
        body.action,
        body.resourceType,
        body.resourceId ?? null,
        body.context ?? {},
      );
      return c.json({ requestId });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/permission-requests", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const actorId = c.req.query("actorId") ?? undefined;
      const requests = await service.listOpenPermissionRequests(auth.principal.orgId, actorId);
      return c.json({ requests });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/permission-requests/:requestId", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const request = await service.getPermissionRequest(auth.principal.orgId, c.req.param("requestId"));
      if (!request) {
        return c.json({ error: `permission request not found: ${c.req.param("requestId")}`, code: "NOT_FOUND" }, 404);
      }
      return c.json({ request });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.post("/v1/permission-requests/:requestId/resolve", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const body = await parseJsonBody(c, resolvePermissionRequestBody);
      const result = await service.resolvePermissionRequest(
        auth.principal,
        c.req.param("requestId"),
        body.approve,
        {
          notes: body.notes,
          expiresAt: body.expiresAt ?? null,
          maxUses: body.maxUses ?? null,
        },
      );
      return c.json({ ok: true, ...result });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // artifacts
  app.post("/v1/artifacts", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const body = await parseJsonBody(c, registerArtifactBody);
      let content: Buffer;
      try {
        content = Buffer.from(body.contentBase64, "base64");
      } catch {
        throw new ValidationError("contentBase64 is not valid base64");
      }
      if (content.byteLength === 0) throw new ValidationError("contentBase64 decoded to zero bytes");
      const record = await service.registerArtifact(auth.principal, {
        streamId: body.streamId,
        streamType: body.streamType,
        filename: body.filename,
        contentType: body.contentType,
        content,
        sha256: body.sha256,
      });
      return c.json({ artifact: record });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/artifacts/:artifactId", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const record = await service.getArtifactMetadata(auth.principal, c.req.param("artifactId"));
      return c.json({ artifact: record });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/artifacts/:artifactId/content", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const { metadata, content } = await service.downloadArtifact(auth.principal, c.req.param("artifactId"));
      // Let the HTTP server compute `Content-Length` from the body so we
      // don't duplicate it when running behind `@hono/node-server`. The
      // sidecar headers carry the size + digest for clients that want to
      // verify without parsing the body.
      const headers = new Headers({
        "content-type": metadata.contentType,
        "content-disposition": `attachment; filename="${encodeFilename(metadata.filename)}"`,
        "x-artifact-id": metadata.id,
        "x-artifact-size": String(metadata.size),
        "x-artifact-sha256": metadata.sha256,
      });
      return new Response(new Uint8Array(content), { status: 200, headers });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/streams/:streamId/artifacts", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const includeDeleted = c.req.query("includeDeleted") === "true";
      const artifacts = await service.listArtifacts(auth.principal, c.req.param("streamId"), {
        includeDeleted,
      });
      return c.json({ artifacts });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.delete("/v1/artifacts/:artifactId", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const reason = c.req.query("reason") ?? "";
      await service.deleteArtifact(auth.principal, c.req.param("artifactId"), reason);
      return c.json({ ok: true });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // clients
  app.post("/v1/clients", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const body = await parseJsonBody(c, clientBody);
      const clientId = await service.registerClient(auth.principal, body.endpoint, body.metadata ?? {});
      return c.json({ clientId });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // audit
  app.get("/v1/audit/rows", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      if (!auth.principal.scopes.includes("audit:read")) {
        return c.json({ error: "missing audit:read scope", code: "PERMISSION_DENIED" }, 403);
      }
      const actorId = c.req.query("actorId") ?? undefined;
      const limitRaw = c.req.query("limit");
      const limit = limitRaw ? Math.max(1, Math.min(5000, Number(limitRaw))) : undefined;
      const rows = await service.auditRows(auth.principal.orgId, { actorId, limit });
      return c.json({ rows });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // Revoke every live grant held by one actor in one call. Org-level
  // admin operation ("kick agent"). Requires `grant:create` like any other
  // grant mutation.
  app.post("/v1/actors/:actorId/revoke-grants", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      let reason = "";
      const raw = await c.req.text();
      if (raw.length > 0) {
        const parsed = revokeAllGrantsBody.parse(JSON.parse(raw));
        reason = parsed.reason ?? "";
      }
      const result = await service.revokeAllGrantsForActor(auth.principal, c.req.param("actorId"), reason);
      return c.json(result);
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/actors/:actorId/grants", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      const grants = await service.listActorEffectiveGrants(
        auth.principal,
        c.req.param("actorId"),
      );
      return c.json({ grants });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get("/v1/audit/verify", async (c) => {
    const auth = authed(c);
    if ("response" in auth) return auth.response;
    try {
      if (!auth.principal.scopes.includes("audit:read")) {
        return c.json({ error: "missing audit:read scope", code: "PERMISSION_DENIED" }, 403);
      }
      const result = await service.verifyAuditChain(auth.principal.orgId);
      return c.json(result);
    } catch (e) {
      return handleError(c, e);
    }
  });

  return app;
}
