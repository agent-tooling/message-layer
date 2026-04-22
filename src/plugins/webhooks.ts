import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { PermissionError, ValidationError, eventTypeSchema, principalSchema, type DomainEvent, type EventType, type Principal } from "../types.js";
import { isWebhookSupportedEventType } from "../event-support.js";
import type { ServerPlugin } from "../plugins.js";
import {
  assertWebhookEndpointSafe,
  BlockedEndpointError,
  type WebhookEndpointCheckOptions,
} from "./webhook-ssrf-guard.js";

type WebhookSubscriptionRow = {
  id: string;
  org_id: string;
  actor_id: string;
  endpoint: string;
  event_types_json: string;
  stream_id: string | null;
  secret: string | null;
  enabled: number;
  created_at: string;
};

const webhookEventTypeSchema = eventTypeSchema.refine((eventType) => isWebhookSupportedEventType(eventType), {
  message: "event type is not supported by webhook transport",
});

const createSubscriptionBody = z.object({
  endpoint: z.string().url(),
  eventTypes: z.array(webhookEventTypeSchema).min(1),
  streamId: z.string().min(1).nullable().optional(),
  secret: z.string().min(8).max(256).optional(),
});

const updateSubscriptionBody = z.object({
  enabled: z.boolean(),
});

const boolQuerySchema = z.enum(["true", "false"]).optional();

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

function parseEventTypes(raw: string): EventType[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  const out: EventType[] = [];
  for (const value of parsed) {
    const item = eventTypeSchema.safeParse(value);
    if (item.success) out.push(item.data);
  }
  return out;
}

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function hasCapability(
  principal: Principal,
  capability: "webhook:subscribe" | "webhook:read",
  serviceHasGrant: (orgId: string, actorId: string, capability: string) => Promise<boolean>,
): Promise<boolean> {
  if (principal.scopes.includes(capability)) return true;
  return serviceHasGrant(principal.orgId, principal.actorId, capability);
}

async function assertPrincipalInOrg(
  principal: Principal,
  query: (sql: string, params?: Array<string | number | null>) => Promise<{ rows: Array<{ ok: number }> }>,
): Promise<void> {
  const row = await query(
    "SELECT 1 AS ok FROM actors WHERE id=? AND org_id=? LIMIT 1",
    [principal.actorId, principal.orgId],
  );
  if (!row.rows[0]) {
    throw new PermissionError("actor is not in org");
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof PermissionError) {
    return new Response(JSON.stringify({ error: error.message, code: "PERMISSION_DENIED" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  if (error instanceof BlockedEndpointError) {
    return new Response(
      JSON.stringify({ error: error.message, code: error.code, reason: error.reason }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  if (error instanceof ValidationError || error instanceof z.ZodError) {
    return new Response(JSON.stringify({ error: "invalid request", code: "VALIDATION" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (error instanceof Error) {
    return new Response(JSON.stringify({ error: error.message, code: "ERROR" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ error: "unexpected error", code: "ERROR" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

export function webhookPlugin(options?: Record<string, unknown>): ServerPlugin {
  const mountPath = typeof options?.mountPath === "string" ? options.mountPath : "/v1/webhooks";
  const timeoutMs = Number(options?.timeoutMs ?? 5000);
  const defaultSecret = typeof options?.defaultSecret === "string" ? options.defaultSecret : null;
  // SSRF guard: by default we refuse to dispatch to loopback / RFC1918 /
  // link-local / cloud-metadata addresses so that a stolen `webhook:subscribe`
  // scope cannot be turned into "read arbitrary internal HTTP". Deployments
  // that really need in-cluster hooks opt in explicitly.
  const allowPrivateNetworks = options?.allowPrivateNetworks === true;
  // Tests override the resolver via `options.lookup`; production always uses
  // the system resolver so `/etc/hosts`, split-horizon DNS, etc. apply.
  const lookup = typeof options?.lookup === "function"
    ? (options.lookup as WebhookEndpointCheckOptions["lookup"])
    : undefined;
  const endpointCheckOptions: WebhookEndpointCheckOptions = {
    allowPrivateNetworks,
    lookup,
  };

  return {
    name: "webhooks",
    schemaSql: {
      name: "webhooks",
      sql: [
        `CREATE TABLE IF NOT EXISTS webhook_subscriptions (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          event_types_json TEXT NOT NULL,
          stream_id TEXT,
          secret TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (org_id) REFERENCES organizations(id),
          FOREIGN KEY (actor_id) REFERENCES actors(id)
        )`,
        "CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_org ON webhook_subscriptions(org_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_stream ON webhook_subscriptions(org_id, stream_id)",
        `CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id TEXT PRIMARY KEY,
          subscription_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          stream_id TEXT,
          status_code INTEGER,
          success INTEGER NOT NULL,
          response_body TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (subscription_id) REFERENCES webhook_subscriptions(id)
        )`,
        "CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription ON webhook_deliveries(subscription_id, created_at)",
      ],
    },
    registerRoutes(ctx) {
      ctx.app.post(`${mountPath}/subscriptions`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const allowed = await hasCapability(principal, "webhook:subscribe", ctx.service.checkGrant.bind(ctx.service));
          if (!allowed) {
            throw new PermissionError("missing webhook:subscribe");
          }
          const body = createSubscriptionBody.parse(await c.req.json());
          // Fail fast with a clear 400 before the row is even inserted —
          // an attacker that probes many endpoints shouldn't be able to
          // pollute `webhook_subscriptions` with blocked URLs.
          await assertWebhookEndpointSafe(body.endpoint, endpointCheckOptions);
          if (body.streamId) {
            await ctx.service.assertCanReadStream(principal, body.streamId);
          }
          const id = randomUUID().replaceAll("-", "");
          const createdAt = new Date().toISOString();
          const secret = body.secret ?? defaultSecret;
          await ctx.db.query(
            `INSERT INTO webhook_subscriptions(
               id,org_id,actor_id,endpoint,event_types_json,stream_id,secret,enabled,created_at,updated_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              id,
              principal.orgId,
              principal.actorId,
              body.endpoint,
              JSON.stringify(body.eventTypes),
              body.streamId ?? null,
              secret,
              1,
              createdAt,
              createdAt,
            ],
          );
          return c.json({ subscriptionId: id });
        } catch (error) {
          return errorResponse(error);
        }
      });

      ctx.app.get(`${mountPath}/subscriptions`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const includeDisabled = boolQuerySchema.parse(c.req.query("includeDisabled")) === "true";
          const canReadAll = await hasCapability(principal, "webhook:read", ctx.service.checkGrant.bind(ctx.service));
          const params: Array<string | number | null> = [principal.orgId];
          let sql = `SELECT id,org_id,actor_id,endpoint,event_types_json,stream_id,enabled,created_at
                     FROM webhook_subscriptions
                     WHERE org_id=?`;
          if (!canReadAll) {
            sql += " AND actor_id=?";
            params.push(principal.actorId);
          }
          if (!includeDisabled) {
            sql += " AND enabled=1";
          }
          sql += " ORDER BY created_at DESC";
          const rows = await ctx.db.query<WebhookSubscriptionRow>(sql, params);
          return c.json({
            subscriptions: rows.rows.map((row) => ({
              id: row.id,
              orgId: row.org_id,
              actorId: row.actor_id,
              endpoint: row.endpoint,
              eventTypes: parseEventTypes(row.event_types_json),
              streamId: row.stream_id,
              enabled: row.enabled === 1,
              createdAt: row.created_at,
            })),
          });
        } catch (error) {
          return errorResponse(error);
        }
      });

      ctx.app.patch(`${mountPath}/subscriptions/:subscriptionId`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const body = updateSubscriptionBody.parse(await c.req.json());
          const canReadAll = await hasCapability(principal, "webhook:read", ctx.service.checkGrant.bind(ctx.service));
          const existing = await ctx.db.query<{ org_id: string; actor_id: string }>(
            "SELECT org_id,actor_id FROM webhook_subscriptions WHERE id=?",
            [c.req.param("subscriptionId")],
          );
          const row = existing.rows[0];
          if (!row || row.org_id !== principal.orgId) {
            return c.json({ error: "subscription not found", code: "NOT_FOUND" }, 404);
          }
          if (!canReadAll && row.actor_id !== principal.actorId) {
            throw new PermissionError("missing webhook:read");
          }
          await ctx.db.query(
            "UPDATE webhook_subscriptions SET enabled=?, updated_at=? WHERE id=?",
            [body.enabled ? 1 : 0, new Date().toISOString(), c.req.param("subscriptionId")],
          );
          return c.json({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      });
    },
    async onEvent(event, ctx) {
      if (!isWebhookSupportedEventType(event.type)) return;
      const rows = await ctx.db.query<WebhookSubscriptionRow>(
        `SELECT id,org_id,actor_id,endpoint,event_types_json,stream_id,secret,enabled,created_at
         FROM webhook_subscriptions
         WHERE org_id=? AND enabled=1`,
        [event.orgId],
      );
      const matching = rows.rows.filter((row) => {
        if (row.stream_id !== null && row.stream_id !== event.streamId) return false;
        const types = parseEventTypes(row.event_types_json);
        return types.includes(event.type);
      });
      if (matching.length === 0) return;

      const deliveries = matching.map(async (sub) => {
        const deliveryId = randomUUID().replaceAll("-", "");
        const createdAt = new Date().toISOString();
        let statusCode: number | null = null;
        let success = false;
        let responseBody: string | null = null;
        let errorMessage: string | null = null;
        const payload = {
          deliveryId,
          subscriptionId: sub.id,
          event,
        };
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "x-message-layer-delivery-id": deliveryId,
          "x-message-layer-event-type": event.type,
        };
        const body = JSON.stringify(payload);
        if (sub.secret) {
          headers["x-message-layer-signature"] = createHmac("sha256", sub.secret).update(body).digest("hex");
        }
        try {
          // Re-check every delivery: DNS records may have changed since the
          // subscription was created (the classic DNS-rebinding angle) and
          // the plugin may have been reconfigured to a stricter policy. We
          // still have a small TOCTOU window between this resolve and the
          // socket connect inside `fetch`, but the check closes the main
          // hole (subscribe-then-exfiltrate) without requiring a bespoke
          // connection dispatcher.
          await assertWebhookEndpointSafe(sub.endpoint, endpointCheckOptions);
          const response = await fetch(sub.endpoint, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          statusCode = response.status;
          responseBody = await response.text();
          success = response.ok;
        } catch (error) {
          if (error instanceof BlockedEndpointError) {
            errorMessage = `${error.code}: ${error.message}`;
          } else {
            errorMessage = error instanceof Error ? error.message : String(error);
          }
        }
        await ctx.db.query(
          `INSERT INTO webhook_deliveries(
             id,subscription_id,org_id,event_type,stream_id,status_code,success,response_body,error_message,created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            deliveryId,
            sub.id,
            sub.org_id,
            event.type,
            event.streamId,
            statusCode,
            success ? 1 : 0,
            responseBody,
            errorMessage,
            createdAt,
          ],
        );
      });
      await Promise.allSettled(deliveries);
    },
  };
}

export function webhookPayloadFromBody(raw: string): { event: DomainEvent | null } {
  const parsed = safeJsonParse(raw);
  const event = parsed.event;
  if (!event || typeof event !== "object") return { event: null };
  return { event: event as DomainEvent };
}
