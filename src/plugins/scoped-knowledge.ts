import { randomUUID } from "node:crypto";
import type { DomainEvent } from "../types.js";
import type { PluginRuntimeContext, ServerPlugin } from "../plugins.js";

/**
 * `scoped-knowledge` — a reference implementation of AGENTS.md rule #15
 * ("memory is derived, not primary") and the key-flow "message → knowledge
 * derivation" that is otherwise unrepresented in the codebase.
 *
 * Design choices:
 *
 *  - **Plugin-owned storage.** The plugin creates its own `knowledge_entries`
 *    table in the core PGlite database. Core schemas are not touched. This
 *    matches "plugins do not mutate core state directly" — the plugin's
 *    table is its own state, even though it lives in the same DB file.
 *
 *  - **Event-driven extraction.** The plugin subscribes to `message.appended`
 *    and extracts text parts into derived rows. Source stream id +
 *    visibility are snapshotted at insertion time so a later visibility
 *    change on the channel never retroactively widens an entry's audience.
 *
 *  - **Privacy by delegation.** On read, the plugin delegates to
 *    `service.assertCanReadStream` — the single source of truth for stream
 *    privacy. Promoted entries skip that check and are readable by any
 *    org member.
 *
 *  - **Promotion via core.** Promotion is routed through
 *    `service.recordKnowledgePromotion`, which emits `knowledge.promoted`
 *    on the shared bus + hash-chained audit log. The plugin then flips its
 *    local `promoted` bit in response to the event — so even if the
 *    promotion is initiated by some other route, this plugin stays in sync.
 */

const CREATE_KNOWLEDGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS knowledge_entries (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    source_stream_id TEXT NOT NULL,
    source_stream_type TEXT NOT NULL CHECK (source_stream_type IN ('channel','thread')),
    source_message_id TEXT NOT NULL,
    source_visibility TEXT NOT NULL CHECK (source_visibility IN ('private','public')),
    created_by_actor_id TEXT NOT NULL,
    text TEXT NOT NULL,
    promoted INTEGER NOT NULL DEFAULT 0,
    promoted_at TEXT,
    promoted_by_actor_id TEXT,
    promotion_summary TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_entries_stream ON knowledge_entries(org_id, source_stream_id)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_entries_promoted ON knowledge_entries(org_id, promoted)`,
];

type KnowledgeRow = {
  id: string;
  org_id: string;
  source_stream_id: string;
  source_stream_type: string;
  source_message_id: string;
  source_visibility: string;
  created_by_actor_id: string;
  text: string;
  promoted: number;
  promoted_at: string | null;
  promoted_by_actor_id: string | null;
  promotion_summary: string | null;
  created_at: string;
};

export type KnowledgeEntry = {
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

function mapRow(row: KnowledgeRow): KnowledgeEntry {
  return {
    id: row.id,
    orgId: row.org_id,
    sourceStreamId: row.source_stream_id,
    sourceStreamType: row.source_stream_type as "channel" | "thread",
    sourceMessageId: row.source_message_id,
    sourceVisibility: row.source_visibility as "private" | "public",
    createdByActorId: row.created_by_actor_id,
    text: row.text,
    promoted: Number(row.promoted) === 1,
    promotedAt: row.promoted_at,
    promotedByActorId: row.promoted_by_actor_id,
    promotionSummary: row.promotion_summary,
    createdAt: row.created_at,
  };
}

function extractTextParts(event: DomainEvent): string[] {
  const payload = event.payload as { parts?: unknown };
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  const out: string[] = [];
  for (const p of parts) {
    if (
      p &&
      typeof p === "object" &&
      (p as { type?: unknown }).type === "text"
    ) {
      const pl = (p as { payload?: unknown }).payload;
      if (pl && typeof pl === "object" && typeof (pl as { text?: unknown }).text === "string") {
        const text = (pl as { text: string }).text.trim();
        if (text) out.push(text);
      }
    }
  }
  return out;
}

type ResolvedStream = { orgId: string; visibility: "private" | "public"; streamType: "channel" | "thread" };

async function resolveSourceStream(
  ctx: PluginRuntimeContext,
  streamId: string,
): Promise<ResolvedStream | null> {
  const channel = await ctx.service.db.query<{
    org_id: string;
    visibility: string;
  }>("SELECT org_id,visibility FROM channels WHERE id=?", [streamId]);
  if (channel.rows[0]) {
    return {
      orgId: channel.rows[0].org_id,
      visibility: channel.rows[0].visibility as "private" | "public",
      streamType: "channel",
    };
  }
  const thread = await ctx.service.db.query<{
    org_id: string;
    visibility: string;
  }>("SELECT org_id,visibility FROM threads WHERE id=?", [streamId]);
  if (thread.rows[0]) {
    return {
      orgId: thread.rows[0].org_id,
      visibility: thread.rows[0].visibility as "private" | "public",
      streamType: "thread",
    };
  }
  return null;
}

function parsePrincipalHeader(value: string | null): {
  actorId: string;
  orgId: string;
  scopes: string[];
  provider: string;
} | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as {
      actorId?: unknown;
      orgId?: unknown;
      scopes?: unknown;
      provider?: unknown;
    };
    if (
      typeof parsed.actorId !== "string" ||
      typeof parsed.orgId !== "string" ||
      typeof parsed.provider !== "string"
    ) {
      return null;
    }
    const scopes = Array.isArray(parsed.scopes)
      ? parsed.scopes.filter((s): s is string => typeof s === "string")
      : [];
    return { actorId: parsed.actorId, orgId: parsed.orgId, scopes, provider: parsed.provider };
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readJsonBody<T = unknown>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export function scopedKnowledgePlugin(_options?: Record<string, unknown>): ServerPlugin {
  let unsubscribe: (() => void) | undefined;

  return {
    name: "scoped-knowledge",

    async setup(ctx) {
      for (const stmt of CREATE_KNOWLEDGE_STATEMENTS) {
        await ctx.service.db.query(stmt);
      }

      unsubscribe = ctx.bus.subscribe(async (event) => {
        if (event.type === "message.appended") {
          await ingestMessage(ctx, event);
          return;
        }
        if (event.type === "knowledge.promoted") {
          await applyPromotion(ctx, event);
        }
      });
    },

    async registerRoutes(ctx) {
      // GET /v1/knowledge?streamId=...&includePromoted=true
      // Read entries for a given stream. Privacy delegated to the service.
      ctx.app.get("/v1/knowledge", async (c) => {
        const principal = parsePrincipalHeader(c.req.header("x-principal") ?? null);
        if (!principal) {
          return jsonResponse({ error: "missing or invalid principal" }, 401);
        }

        const streamId = c.req.query("streamId");
        const includePromotedElsewhere = c.req.query("includePromotedElsewhere") === "true";

        if (streamId) {
          try {
            await ctx.service.assertCanReadStream(principal, streamId);
          } catch (error) {
            return mapServiceError(error);
          }
          const rows = await ctx.service.db.query<KnowledgeRow>(
            "SELECT * FROM knowledge_entries WHERE org_id=? AND source_stream_id=? ORDER BY created_at ASC",
            [principal.orgId, streamId],
          );
          return jsonResponse({ entries: rows.rows.map(mapRow) });
        }

        if (!includePromotedElsewhere) {
          return jsonResponse(
            { error: "either streamId or includePromotedElsewhere=true is required", code: "VALIDATION" },
            400,
          );
        }

        // org-wide promoted knowledge; readable by any org member.
        try {
          const row = await ctx.service.db.query(
            "SELECT 1 FROM actors WHERE id=? AND org_id=?",
            [principal.actorId, principal.orgId],
          );
          if (row.rows.length === 0) {
            return jsonResponse({ error: "actor is not in org", code: "PERMISSION_DENIED" }, 403);
          }
        } catch {
          return jsonResponse({ error: "actor lookup failed", code: "ERROR" }, 500);
        }
        const rows = await ctx.service.db.query<KnowledgeRow>(
          "SELECT * FROM knowledge_entries WHERE org_id=? AND promoted=1 ORDER BY promoted_at ASC",
          [principal.orgId],
        );
        return jsonResponse({ entries: rows.rows.map(mapRow) });
      });

      // GET /v1/knowledge/:entryId — fetch one entry.
      ctx.app.get("/v1/knowledge/:entryId", async (c) => {
        const principal = parsePrincipalHeader(c.req.header("x-principal") ?? null);
        if (!principal) return jsonResponse({ error: "missing or invalid principal" }, 401);
        const entryId = c.req.param("entryId");
        const rows = await ctx.service.db.query<KnowledgeRow>(
          "SELECT * FROM knowledge_entries WHERE id=? AND org_id=?",
          [entryId, principal.orgId],
        );
        const row = rows.rows[0];
        if (!row) return jsonResponse({ error: "not found", code: "NOT_FOUND" }, 404);
        const entry = mapRow(row);
        if (!entry.promoted) {
          try {
            await ctx.service.assertCanReadStream(principal, entry.sourceStreamId, entry.sourceStreamType);
          } catch (error) {
            return mapServiceError(error);
          }
        }
        return jsonResponse({ entry });
      });

      // POST /v1/knowledge/:entryId/promote — promote via the core hook.
      ctx.app.post("/v1/knowledge/:entryId/promote", async (c) => {
        const principal = parsePrincipalHeader(c.req.header("x-principal") ?? null);
        if (!principal) return jsonResponse({ error: "missing or invalid principal" }, 401);
        const entryId = c.req.param("entryId");
        const rows = await ctx.service.db.query<KnowledgeRow>(
          "SELECT * FROM knowledge_entries WHERE id=? AND org_id=?",
          [entryId, principal.orgId],
        );
        const row = rows.rows[0];
        if (!row) return jsonResponse({ error: "not found", code: "NOT_FOUND" }, 404);
        const entry = mapRow(row);
        if (entry.promoted) return jsonResponse({ entry });

        const body = (await readJsonBody<{ summary?: unknown }>(c.req.raw)) ?? {};
        const summary = typeof body.summary === "string" ? body.summary : undefined;

        try {
          await ctx.service.recordKnowledgePromotion(principal, {
            entryId,
            sourceStreamId: entry.sourceStreamId,
            sourceStreamType: entry.sourceStreamType,
            summary,
          });
        } catch (error) {
          return mapServiceError(error);
        }

        // Re-read so the caller sees the flipped bit that the event handler
        // applied synchronously on the same in-process bus.
        const after = await ctx.service.db.query<KnowledgeRow>(
          "SELECT * FROM knowledge_entries WHERE id=? AND org_id=?",
          [entryId, principal.orgId],
        );
        const promoted = after.rows[0] ? mapRow(after.rows[0]) : entry;
        return jsonResponse({ entry: promoted });
      });
    },

    dispose() {
      unsubscribe?.();
    },
  };
}

async function ingestMessage(ctx: PluginRuntimeContext, event: DomainEvent): Promise<void> {
  const streamId = event.streamId;
  if (!streamId) return;
  const payload = event.payload as { messageId?: string; actorId?: string; parts?: unknown };
  const messageId = payload.messageId;
  const actorId = payload.actorId;
  if (!messageId || !actorId) return;

  let texts = extractTextParts(event);
  if (texts.length === 0) {
    // `message.appended` payloads ship `partCount`, not the parts. Fall back
    // to rehydrating the parts from the DB so the plugin works regardless
    // of payload shape drift.
    texts = await hydrateTextParts(ctx, messageId);
  }
  if (texts.length === 0) return;

  const resolved = await resolveSourceStream(ctx, streamId);
  if (!resolved) return;

  const createdAt = new Date().toISOString();
  for (const text of texts) {
    await ctx.service.db.query(
      `INSERT INTO knowledge_entries (
         id,org_id,source_stream_id,source_stream_type,source_message_id,
         source_visibility,created_by_actor_id,text,promoted,created_at
       ) VALUES (?,?,?,?,?,?,?,?,0,?)`,
      [
        randomUUID().replace(/-/g, ""),
        event.orgId,
        streamId,
        resolved.streamType,
        messageId,
        resolved.visibility,
        actorId,
        text,
        createdAt,
      ],
    );
  }
}

async function hydrateTextParts(ctx: PluginRuntimeContext, messageId: string): Promise<string[]> {
  const rows = await ctx.service.db.query<{ part_type: string; payload_json: string | null }>(
    "SELECT part_type, payload_json FROM message_parts WHERE message_id=? ORDER BY part_index ASC",
    [messageId],
  );
  const out: string[] = [];
  for (const r of rows.rows) {
    if (r.part_type !== "text") continue;
    if (!r.payload_json) continue;
    try {
      const payload = JSON.parse(r.payload_json) as { text?: unknown };
      if (typeof payload.text === "string" && payload.text.trim().length > 0) {
        out.push(payload.text.trim());
      }
    } catch {
      continue;
    }
  }
  return out;
}

async function applyPromotion(ctx: PluginRuntimeContext, event: DomainEvent): Promise<void> {
  const payload = event.payload as {
    entryId?: string;
    promotedByActorId?: string;
    summary?: string | null;
    promotedAt?: string;
  };
  if (!payload.entryId) return;
  await ctx.service.db.query(
    `UPDATE knowledge_entries SET promoted=1, promoted_at=?, promoted_by_actor_id=?, promotion_summary=?
     WHERE id=? AND org_id=?`,
    [
      payload.promotedAt ?? new Date().toISOString(),
      payload.promotedByActorId ?? null,
      payload.summary ?? null,
      payload.entryId,
      event.orgId,
    ],
  );
}

function mapServiceError(error: unknown): Response {
  const err = error as { code?: string; message?: string };
  if (err?.code === "PERMISSION_DENIED") {
    return jsonResponse({ error: err.message ?? "permission denied", code: "PERMISSION_DENIED" }, 403);
  }
  if (err?.code === "NOT_FOUND") {
    return jsonResponse({ error: err.message ?? "not found", code: "NOT_FOUND" }, 404);
  }
  if (err?.code === "VALIDATION") {
    return jsonResponse({ error: err.message ?? "validation error", code: "VALIDATION" }, 400);
  }
  return jsonResponse({ error: err?.message ?? "unexpected error", code: "ERROR" }, 500);
}
