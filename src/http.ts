import { Hono } from "hono";
import type { Context } from "hono";
import { MessageLayerService } from "./service.js";
import { PermissionError } from "./service.js";
import type { Principal } from "./types.js";

function parsePrincipal(headerValue: string | undefined): Principal | null {
  if (!headerValue) {
    return null;
  }
  try {
    const parsed = JSON.parse(headerValue) as Principal;
    if (!parsed.actorId || !parsed.orgId || !Array.isArray(parsed.scopes) || !parsed.provider) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function createApp(service: MessageLayerService): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  function requirePrincipal(c: Context): Principal | Response {
    const principal = parsePrincipal(c.req.header("x-principal"));
    if (!principal) {
      return c.json({ error: "missing or invalid principal" }, 401);
    }
    return principal;
  }

  function handleError(c: Context, error: unknown): Response {
    if (error instanceof PermissionError) {
      return c.json({ error: error.message }, 403);
    }
    if (error instanceof Error) {
      return c.json({ error: error.message }, 400);
    }
    return c.json({ error: "unexpected error" }, 500);
  }

  app.post("/v1/orgs", async (c) => {
    try {
      const body = await c.req.json<{ name: string }>();
      const orgId = await service.createOrg(body.name);
      return c.json({ orgId });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/v1/actors", async (c) => {
    try {
      const body = await c.req.json<{ orgId: string; actorType: "human" | "agent" | "app"; displayName: string }>();
      const actorId = await service.createActor(body.orgId, body.actorType, body.displayName);
      return c.json({ actorId });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/v1/channels", async (c) => {
    const principalOrResponse = requirePrincipal(c);
    if (principalOrResponse instanceof Response) {
      return principalOrResponse;
    }
    const principal = principalOrResponse;
    try {
      const body = await c.req.json<{ name: string; visibility?: "private" | "public" }>();
      const channelId = await service.createChannel(principal, body.name, body.visibility ?? "private");
      return c.json({ channelId });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/v1/threads", async (c) => {
    const principalOrResponse = requirePrincipal(c);
    if (principalOrResponse instanceof Response) {
      return principalOrResponse;
    }
    const principal = principalOrResponse;
    try {
      const body = await c.req.json<{
        channelId: string;
        parentMessageId: string;
        visibility?: "private" | "public";
      }>();
      const threadId = await service.createThread(
        principal,
        body.channelId,
        body.parentMessageId,
        body.visibility ?? "private",
      );
      return c.json({ threadId });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/v1/messages", async (c) => {
    const principalOrResponse = requirePrincipal(c);
    if (principalOrResponse instanceof Response) {
      return principalOrResponse;
    }
    const principal = principalOrResponse;
    try {
      const body = await c.req.json<{
        streamId: string;
        streamType: "channel" | "thread";
        parts: Array<{
          type: "text" | "tool_call" | "tool_result" | "artifact" | "approval_request" | "approval_response";
          payload: Record<string, unknown>;
        }>;
        idempotencyKey: string;
      }>();
      const message = await service.appendMessage(principal, {
        streamId: body.streamId,
        streamType: body.streamType,
        parts: body.parts,
        idempotencyKey: body.idempotencyKey,
      });
      return c.json(message);
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.get("/v1/streams/:streamId/messages", async (c) => {
    const principalOrResponse = requirePrincipal(c);
    if (principalOrResponse instanceof Response) {
      return principalOrResponse;
    }
    const principal = principalOrResponse;
    try {
      const streamId = c.req.param("streamId");
      const afterSeq = Number(c.req.query("afterSeq") ?? "0");
      const limit = Number(c.req.query("limit") ?? "50");
      const messages = await service.listMessages(principal, streamId, afterSeq, limit);
      return c.json({ messages });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.get("/v1/streams/:streamId/subscribe", async (c) => {
    const principalOrResponse = requirePrincipal(c);
    if (principalOrResponse instanceof Response) {
      return principalOrResponse;
    }
    const principal = principalOrResponse;
    try {
      const streamId = c.req.param("streamId");
      const fromSeq = Number(c.req.query("fromSeq") ?? "0");
      const events = await service.subscribe(principal, streamId, fromSeq);
      return c.json({ events });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/v1/cursors", async (c) => {
    const principalOrResponse = requirePrincipal(c);
    if (principalOrResponse instanceof Response) {
      return principalOrResponse;
    }
    const principal = principalOrResponse;
    try {
      const body = await c.req.json<{ streamId: string; lastSeenSeq: number; lastAckSeq: number }>();
      await service.updateCursor(principal, body.streamId, body.lastSeenSeq, body.lastAckSeq);
      return c.json({ ok: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/v1/grants", async (c) => {
    const principalOrResponse = requirePrincipal(c);
    if (principalOrResponse instanceof Response) {
      return principalOrResponse;
    }
    const principal = principalOrResponse;
    try {
      const body = await c.req.json<{
        actorId: string;
        resourceType: string;
        resourceId: string | null;
        capability: string;
        expiresAt?: string | null;
        constraints?: Record<string, unknown>;
      }>();
      const grantId = await service.createGrant(
        principal,
        body.actorId,
        body.resourceType,
        body.resourceId,
        body.capability,
        body.expiresAt ?? null,
        body.constraints ?? {},
      );
      return c.json({ grantId });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/v1/grants/:grantId/revoke", async (c) => {
    const principalOrResponse = requirePrincipal(c);
    if (principalOrResponse instanceof Response) {
      return principalOrResponse;
    }
    const principal = principalOrResponse;
    try {
      await service.revokeGrant(principal, c.req.param("grantId"));
      return c.json({ ok: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/v1/permission-requests", async (c) => {
    const principalOrResponse = requirePrincipal(c);
    if (principalOrResponse instanceof Response) {
      return principalOrResponse;
    }
    const principal = principalOrResponse;
    try {
      const body = await c.req.json<{
        action: string;
        resourceType: string;
        resourceId: string | null;
      }>();
      const requestId = await service.createPermissionRequest(
        principal,
        body.action,
        body.resourceType,
        body.resourceId,
      );
      return c.json({ requestId });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/v1/permission-requests/:requestId/resolve", async (c) => {
    const principalOrResponse = requirePrincipal(c);
    if (principalOrResponse instanceof Response) {
      return principalOrResponse;
    }
    const principal = principalOrResponse;
    try {
      const body = await c.req.json<{ approve: boolean; notes?: string }>();
      await service.resolvePermissionRequest(
        principal,
        c.req.param("requestId"),
        body.approve,
        body.notes ?? "",
      );
      return c.json({ ok: true });
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.post("/v1/clients", async (c) => {
    const principalOrResponse = requirePrincipal(c);
    if (principalOrResponse instanceof Response) {
      return principalOrResponse;
    }
    const principal = principalOrResponse;
    try {
      const body = await c.req.json<{ endpoint: string; metadata?: Record<string, unknown> }>();
      const clientId = await service.registerClient(principal, body.endpoint, body.metadata ?? {});
      return c.json({ clientId });
    } catch (error) {
      return handleError(c, error);
    }
  });

  return app;
}
