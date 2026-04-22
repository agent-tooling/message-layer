import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PermissionError,
  principalSchema,
  type DomainEvent,
  type Principal,
} from "../types.js";
import type { PluginRuntimeContext, ServerPlugin } from "../plugins.js";
import {
  registerMemoryIndexProvider,
  type MemoryIndexEvent,
  type MemoryUnit,
} from "./memory.js";

/**
 * `search` — generic, privacy-aware lexical search across the core
 * entities the message-layer manages, plus optional memory composition.
 *
 * AGENTS.md alignment:
 *  - rule 1 / 12: index is a derived projection of core domain events
 *    (`org.created`, `membership.updated` carrying scope=`org` for actor
 *    creation, `channel.created`, `thread.created`, `message.appended`,
 *    `message.redacted`). Core never imports this plugin.
 *  - rule 2: search is explicitly listed as a plugin domain.
 *  - rule 6: every result is privacy-filtered through the same core
 *    `assertCanReadStream` / `assertOrgActor` checks the rest of the system
 *    uses, never via ad-hoc HTTP-only logic.
 *  - rule 8: actor results cover humans, agents, and apps with the same
 *    contract. Filters can narrow by `actorType` but the schema is unified.
 *  - rule 11: real e2e flows (PGlite + real server + real bus) cover the
 *    routes; no mocks.
 *  - rule 12: the search plugin functions standalone (memory not required).
 *    When the memory plugin is also enabled it composes through a tiny
 *    in-process registry exposed by `./memory.js` (no hard dependency on
 *    memory's storage or routes).
 *
 * Storage: plugin-owned `search_documents` table only — never touches core
 * tables.
 */

// ── entities ────────────────────────────────────────────────────────────────

export type SearchEntityType = "actor" | "channel" | "thread" | "message" | "memory";

const SEARCH_ENTITY_VALUES = ["actor", "channel", "thread", "message", "memory"] as const;
const searchEntityTypeSchema = z.enum(SEARCH_ENTITY_VALUES);

const searchQuerySchema = z.object({
  q: z.string().trim().min(1, "q is required"),
  entityTypes: z.array(searchEntityTypeSchema).optional(),
  streamId: z.string().optional(),
  actorType: z.enum(["human", "agent", "app"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const suggestQuerySchema = z.object({
  q: z.string().trim().min(1, "q is required"),
  limit: z.number().int().positive().max(20).optional(),
});

// ── schema ─────────────────────────────────────────────────────────────────

const SEARCH_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS search_documents (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('actor','channel','thread','message','memory')),
    entity_id TEXT NOT NULL,
    -- For stream-scoped entities (message, thread, memory) this is the
    -- source streamId; for channel results it's the channel id itself; for
    -- actor results it is NULL (org-scoped privacy applies).
    source_stream_id TEXT,
    source_stream_type TEXT CHECK (source_stream_type IS NULL OR source_stream_type IN ('channel','thread')),
    -- Snapshotted source visibility at index time; mirrors the memory
    -- plugin's privacy contract (AGENTS.md rule 15: derived data never
    -- widens beyond its source unless explicitly promoted).
    source_visibility TEXT CHECK (source_visibility IS NULL OR source_visibility IN ('private','public')),
    -- True for memory documents that have been org-promoted; used so the
    -- ranker can include them in cross-stream search regardless of read
    -- access on the original source stream.
    promoted INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    keywords_json TEXT NOT NULL DEFAULT '[]',
    actor_type TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (org_id, entity_type, entity_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_search_documents_org ON search_documents(org_id, entity_type)`,
  `CREATE INDEX IF NOT EXISTS idx_search_documents_stream ON search_documents(org_id, source_stream_id)`,
  `CREATE INDEX IF NOT EXISTS idx_search_documents_promoted ON search_documents(org_id, promoted)`,
];

// ── document mapping ───────────────────────────────────────────────────────

type SearchDocumentRow = {
  id: string;
  org_id: string;
  entity_type: SearchEntityType;
  entity_id: string;
  source_stream_id: string | null;
  source_stream_type: "channel" | "thread" | null;
  source_visibility: "private" | "public" | null;
  promoted: number;
  title: string;
  body: string;
  keywords_json: string;
  actor_type: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export type SearchHit = {
  documentId: string;
  entityType: SearchEntityType;
  entityId: string;
  score: number;
  title: string;
  snippet: string;
  highlights: string[];
  sourceStreamId: string | null;
  sourceStreamType: "channel" | "thread" | null;
  sourceVisibility: "private" | "public" | null;
  promoted: boolean;
  actorType: "human" | "agent" | "app" | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
};

export type SearchSuggestion = {
  entityType: SearchEntityType;
  entityId: string;
  label: string;
  actorType: "human" | "agent" | "app" | null;
};

// ── helpers ────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has",
  "have", "i", "in", "is", "it", "its", "of", "on", "or", "so", "than", "that",
  "the", "their", "them", "then", "there", "this", "to", "was", "we", "were",
  "with", "you", "your", "our", "us", "if",
]);

function tokenize(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of text.toLowerCase().split(/[^a-z0-9_-]+/g)) {
    if (tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= 32) break;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parsePrincipal(headerValue: string | undefined): Principal | null {
  if (!headerValue) return null;
  try {
    const parsed = principalSchema.safeParse(JSON.parse(headerValue));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
  if (err instanceof z.ZodError) {
    return jsonResponse(
      { error: err.issues.map((i) => i.message).join("; "), code: "VALIDATION" },
      400,
    );
  }
  return jsonResponse({ error: err?.message ?? "unexpected error", code: "ERROR" }, 500);
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function safeParseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function snippetFor(body: string): string {
  return body.length <= 160 ? body : `${body.slice(0, 157)}…`;
}

function deterministicDocId(orgId: string, entityType: string, entityId: string): string {
  return createHash("sha256")
    .update(`${orgId}|${entityType}|${entityId}`)
    .digest("hex")
    .slice(0, 32);
}

// ── upsert / delete ────────────────────────────────────────────────────────

type UpsertInput = {
  orgId: string;
  entityType: SearchEntityType;
  entityId: string;
  sourceStreamId: string | null;
  sourceStreamType: "channel" | "thread" | null;
  sourceVisibility: "private" | "public" | null;
  promoted: boolean;
  title: string;
  body: string;
  actorType?: "human" | "agent" | "app" | null;
  metadata?: Record<string, unknown>;
};

async function upsertDocument(ctx: PluginRuntimeContext, input: UpsertInput): Promise<void> {
  const id = deterministicDocId(input.orgId, input.entityType, input.entityId);
  const now = new Date().toISOString();
  const keywords = JSON.stringify(tokenize(`${input.title} ${input.body}`));
  const existing = await ctx.service.db.query(
    `SELECT 1 FROM search_documents WHERE id=?`,
    [id],
  );
  if (existing.rows.length > 0) {
    await ctx.service.db.query(
      `UPDATE search_documents
          SET source_stream_id=?, source_stream_type=?, source_visibility=?, promoted=?,
              title=?, body=?, keywords_json=?, actor_type=?, metadata_json=?, updated_at=?
        WHERE id=?`,
      [
        input.sourceStreamId,
        input.sourceStreamType,
        input.sourceVisibility,
        input.promoted ? 1 : 0,
        input.title,
        input.body,
        keywords,
        input.actorType ?? null,
        JSON.stringify(input.metadata ?? {}),
        now,
        id,
      ],
    );
    return;
  }
  await ctx.service.db.query(
    `INSERT INTO search_documents(
        id, org_id, entity_type, entity_id,
        source_stream_id, source_stream_type, source_visibility, promoted,
        title, body, keywords_json, actor_type, metadata_json,
        created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.orgId,
      input.entityType,
      input.entityId,
      input.sourceStreamId,
      input.sourceStreamType,
      input.sourceVisibility,
      input.promoted ? 1 : 0,
      input.title,
      input.body,
      keywords,
      input.actorType ?? null,
      JSON.stringify(input.metadata ?? {}),
      now,
      now,
    ],
  );
}

async function deleteDocument(
  ctx: PluginRuntimeContext,
  orgId: string,
  entityType: SearchEntityType,
  entityId: string,
): Promise<void> {
  const id = deterministicDocId(orgId, entityType, entityId);
  await ctx.service.db.query(`DELETE FROM search_documents WHERE id=?`, [id]);
}

// ── ingestion from core domain events ──────────────────────────────────────

async function indexActor(ctx: PluginRuntimeContext, orgId: string, actorId: string): Promise<void> {
  const rows = await ctx.service.db.query<{
    id: string;
    type: string;
    display_name: string;
    created_at: string;
  }>(
    "SELECT id, type, display_name, created_at FROM actors WHERE id=? AND org_id=?",
    [actorId, orgId],
  );
  const row = rows.rows[0];
  if (!row) return;
  await upsertDocument(ctx, {
    orgId,
    entityType: "actor",
    entityId: row.id,
    sourceStreamId: null,
    sourceStreamType: null,
    sourceVisibility: null,
    promoted: false,
    title: row.display_name,
    body: `${row.display_name} (${row.type})`,
    actorType: row.type as "human" | "agent" | "app",
    metadata: { displayName: row.display_name, actorType: row.type, createdAt: row.created_at },
  });
}

async function indexChannelById(
  ctx: PluginRuntimeContext,
  orgId: string,
  channelId: string,
): Promise<void> {
  const rows = await ctx.service.db.query<{
    id: string;
    name: string;
    visibility: string;
    created_at: string;
  }>("SELECT id, name, visibility, created_at FROM channels WHERE id=? AND org_id=?", [
    channelId,
    orgId,
  ]);
  const row = rows.rows[0];
  if (!row) return;
  await upsertDocument(ctx, {
    orgId,
    entityType: "channel",
    entityId: row.id,
    sourceStreamId: row.id,
    sourceStreamType: "channel",
    sourceVisibility: row.visibility as "private" | "public",
    promoted: false,
    title: row.name,
    body: `#${row.name}`,
    metadata: { name: row.name, visibility: row.visibility, createdAt: row.created_at },
  });
}

async function indexThreadById(
  ctx: PluginRuntimeContext,
  orgId: string,
  threadId: string,
): Promise<void> {
  const rows = await ctx.service.db.query<{
    id: string;
    channel_id: string;
    parent_message_id: string;
    visibility: string;
    created_at: string;
  }>(
    "SELECT id, channel_id, parent_message_id, visibility, created_at FROM threads WHERE id=? AND org_id=?",
    [threadId, orgId],
  );
  const row = rows.rows[0];
  if (!row) return;
  // Title pulled from the parent message text part if available.
  let title = `thread ${row.id.slice(0, 6)}`;
  const parentText = await firstTextOfMessage(ctx, row.parent_message_id);
  if (parentText) title = `re: ${parentText.slice(0, 80)}`;
  await upsertDocument(ctx, {
    orgId,
    entityType: "thread",
    entityId: row.id,
    sourceStreamId: row.id,
    sourceStreamType: "thread",
    sourceVisibility: row.visibility as "private" | "public",
    promoted: false,
    title,
    body: title,
    metadata: {
      channelId: row.channel_id,
      parentMessageId: row.parent_message_id,
      visibility: row.visibility,
      createdAt: row.created_at,
    },
  });
}

async function firstTextOfMessage(
  ctx: PluginRuntimeContext,
  messageId: string,
): Promise<string | null> {
  const rows = await ctx.service.db.query<{ part_type: string; payload_json: string | null }>(
    "SELECT part_type, payload_json FROM message_parts WHERE message_id=? ORDER BY part_index ASC",
    [messageId],
  );
  for (const r of rows.rows) {
    if (r.part_type !== "text" || !r.payload_json) continue;
    try {
      const payload = JSON.parse(r.payload_json) as { text?: unknown };
      if (typeof payload.text === "string") return payload.text;
    } catch {
      continue;
    }
  }
  return null;
}

async function indexMessage(ctx: PluginRuntimeContext, event: DomainEvent): Promise<void> {
  const streamId = event.streamId;
  if (!streamId) return;
  const payload = event.payload as {
    messageId?: string;
    actorId?: string;
    streamType?: "channel" | "thread";
  };
  const messageId = payload.messageId;
  const actorId = payload.actorId;
  const streamType = payload.streamType;
  if (!messageId || !actorId || !streamType) return;

  const text = await firstTextOfMessage(ctx, messageId);
  if (!text) return;

  // Get visibility snapshot from the source stream.
  const visRows = await ctx.service.db.query<{ visibility: string }>(
    streamType === "channel"
      ? "SELECT visibility FROM channels WHERE id=?"
      : "SELECT visibility FROM threads WHERE id=?",
    [streamId],
  );
  const visibility = (visRows.rows[0]?.visibility ?? "private") as "private" | "public";

  await upsertDocument(ctx, {
    orgId: event.orgId,
    entityType: "message",
    entityId: messageId,
    sourceStreamId: streamId,
    sourceStreamType: streamType,
    sourceVisibility: visibility,
    promoted: false,
    title: text.length > 80 ? `${text.slice(0, 77)}…` : text,
    body: text,
    metadata: {
      messageId,
      actorId,
      streamId,
      streamType,
      streamSeq: event.streamSeq,
      createdAt: event.createdAt,
    },
  });
}

async function applyMessageRedaction(
  ctx: PluginRuntimeContext,
  event: DomainEvent,
): Promise<void> {
  const payload = event.payload as { messageId?: string };
  if (!payload.messageId) return;
  await deleteDocument(ctx, event.orgId, "message", payload.messageId);
}

// ── memory composition adapter ─────────────────────────────────────────────

function memoryUnitToDoc(unit: MemoryUnit): UpsertInput {
  return {
    orgId: unit.orgId,
    entityType: "memory",
    entityId: unit.id,
    sourceStreamId: unit.sourceStreamId,
    sourceStreamType: unit.sourceStreamType,
    sourceVisibility: unit.sourceVisibility,
    promoted: unit.promoted,
    title: unit.summary,
    body: unit.canonicalText,
    metadata: {
      memoryId: unit.id,
      sourceMessageIds: unit.sourceMessageIds,
      keywords: unit.keywords,
      promoted: unit.promoted,
      promotionSummary: unit.promotionSummary,
      createdAt: unit.createdAt,
    },
  };
}

// ── ranking ────────────────────────────────────────────────────────────────

type ScoredDoc = {
  row: SearchDocumentRow;
  score: number;
  highlights: string[];
};

function scoreDoc(row: SearchDocumentRow, queryTokens: string[]): ScoredDoc {
  const titleLower = row.title.toLowerCase();
  const bodyLower = row.body.toLowerCase();
  const keywords = safeParseStringArray(row.keywords_json);
  const keywordSet = new Set(keywords);

  let score = 0;
  for (const token of queryTokens) {
    if (titleLower === token) {
      score += 12;
      continue;
    }
    if (titleLower.startsWith(token)) score += 8;
    if (titleLower.includes(token)) score += 5;
    if (keywordSet.has(token)) {
      score += 4;
      continue;
    }
    if (new RegExp(`\\b${escapeRegExp(token)}\\b`).test(bodyLower)) score += 2;
    for (const kw of keywords) {
      if (kw.startsWith(token) || token.startsWith(kw)) {
        score += 1;
        break;
      }
    }
  }
  // Per-entity boost: actors and channels are smaller, more targeted hits.
  const entityBoost: Record<SearchEntityType, number> = {
    actor: 3,
    channel: 2,
    thread: 1,
    message: 0,
    memory: 1,
  };
  if (score > 0) score += entityBoost[row.entity_type as SearchEntityType] ?? 0;
  // Recency.
  const ageMs = Date.now() - new Date(row.updated_at).getTime();
  const days = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
  if (score > 0) score += Math.max(0, 1 - days / 30);

  const highlights: string[] = [];
  for (const token of queryTokens) {
    const idx = bodyLower.indexOf(token);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 24);
    const end = Math.min(row.body.length, idx + token.length + 24);
    highlights.push((start > 0 ? "…" : "") + row.body.slice(start, end));
    if (highlights.length >= 3) break;
  }
  return { row, score, highlights };
}

function rowToHit(scored: ScoredDoc): SearchHit {
  const { row, score, highlights } = scored;
  return {
    documentId: row.id,
    entityType: row.entity_type as SearchEntityType,
    entityId: row.entity_id,
    score: Number(score.toFixed(3)),
    title: row.title,
    snippet: snippetFor(row.body),
    highlights,
    sourceStreamId: row.source_stream_id,
    sourceStreamType: row.source_stream_type,
    sourceVisibility: row.source_visibility,
    promoted: Number(row.promoted) === 1,
    actorType: (row.actor_type as "human" | "agent" | "app" | null) ?? null,
    metadata: safeParseJson(row.metadata_json),
    updatedAt: row.updated_at,
  };
}

// ── privacy filter ─────────────────────────────────────────────────────────

async function isVisibleToPrincipal(
  ctx: PluginRuntimeContext,
  principal: Principal,
  row: SearchDocumentRow,
): Promise<boolean> {
  if (row.org_id !== principal.orgId) return false;
  // Org-scoped entities (actors): require org membership only.
  if (row.entity_type === "actor") {
    const r = await ctx.service.db.query(
      "SELECT 1 FROM actors WHERE id=? AND org_id=? LIMIT 1",
      [principal.actorId, principal.orgId],
    );
    return r.rows.length > 0;
  }
  if (row.entity_type === "memory") {
    if (Number(row.promoted) === 1) {
      // org-promoted memory: any org member can read
      const r = await ctx.service.db.query(
        "SELECT 1 FROM actors WHERE id=? AND org_id=? LIMIT 1",
        [principal.actorId, principal.orgId],
      );
      return r.rows.length > 0;
    }
  }
  if (!row.source_stream_id || !row.source_stream_type) return false;
  try {
    await ctx.service.assertCanReadStream(
      principal,
      row.source_stream_id,
      row.source_stream_type,
    );
    return true;
  } catch {
    return false;
  }
}

// ── plugin factory ─────────────────────────────────────────────────────────

export function searchPlugin(_options?: Record<string, unknown>): ServerPlugin {
  let unsubscribeBus: (() => void) | undefined;
  let unregisterMemory: (() => void) | undefined;

  return {
    name: "search",
    schemaSql: { name: "search", sql: SEARCH_SCHEMA },

    async setup(ctx) {
      // Backfill: populate from existing rows so search works immediately
      // even when the plugin is enabled mid-life of an existing org.
      await backfillExisting(ctx);

      unsubscribeBus = ctx.bus.subscribe(async (event) => {
        try {
          if (event.type === "channel.created") {
            const payload = event.payload as { channelId?: string };
            if (payload.channelId) await indexChannelById(ctx, event.orgId, payload.channelId);
            return;
          }
          if (event.type === "thread.created") {
            const payload = event.payload as { threadId?: string };
            if (payload.threadId) await indexThreadById(ctx, event.orgId, payload.threadId);
            return;
          }
          if (event.type === "membership.updated") {
            // Org-scoped membership rows are emitted on actor creation; index
            // on every org-scoped update so type/displayName changes flow in.
            const payload = event.payload as { scope?: string; actorId?: string };
            if (payload.scope === "org" && payload.actorId) {
              await indexActor(ctx, event.orgId, payload.actorId);
            }
            return;
          }
          if (event.type === "message.appended") {
            await indexMessage(ctx, event);
            return;
          }
          if (event.type === "message.redacted") {
            await applyMessageRedaction(ctx, event);
          }
        } catch {
          // Search must never break the publishing transaction. Errors are
          // swallowed here intentionally — re-attempts happen on the next
          // event of the same kind, and a periodic backfill could be added
          // by a future operations plugin.
        }
      });

      // Composition with the memory plugin (optional).
      unregisterMemory = registerMemoryIndexProvider(async (event: MemoryIndexEvent) => {
        if (event.kind === "delete") {
          await deleteDocument(ctx, event.orgId, "memory", event.memoryId);
          return;
        }
        await upsertDocument(ctx, memoryUnitToDoc(event.unit));
      });
    },

    registerRoutes(ctx) {
      ctx.app.get("/v1/search", async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) return jsonResponse({ error: "missing or invalid principal" }, 401);

        let parsed: z.infer<typeof searchQuerySchema>;
        try {
          parsed = searchQuerySchema.parse({
            q: c.req.query("q") ?? "",
            entityTypes: parseCsv(c.req.query("entityTypes"))?.filter(
              (v): v is SearchEntityType => SEARCH_ENTITY_VALUES.includes(v as SearchEntityType),
            ),
            streamId: c.req.query("streamId") || undefined,
            actorType:
              c.req.query("actorType") === "human" ||
              c.req.query("actorType") === "agent" ||
              c.req.query("actorType") === "app"
                ? (c.req.query("actorType") as "human" | "agent" | "app")
                : undefined,
            limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
          });
        } catch (error) {
          return mapServiceError(error);
        }

        try {
          await assertActorInOrg(ctx, principal);
        } catch (error) {
          return mapServiceError(error);
        }

        const queryTokens = tokenize(parsed.q);
        const limit = parsed.limit ?? 20;

        const params: Array<string | number | null> = [principal.orgId];
        let sql = `SELECT * FROM search_documents WHERE org_id=?`;
        if (parsed.entityTypes && parsed.entityTypes.length > 0) {
          sql += ` AND entity_type IN (${parsed.entityTypes.map(() => "?").join(",")})`;
          params.push(...parsed.entityTypes);
        }
        if (parsed.streamId) {
          sql += ` AND (source_stream_id=? OR (entity_type='actor'))`;
          params.push(parsed.streamId);
        }
        if (parsed.actorType) {
          sql += ` AND (actor_type=? OR entity_type<>'actor')`;
          params.push(parsed.actorType);
        }
        sql += ` ORDER BY updated_at DESC LIMIT 500`;
        const rows = await ctx.service.db.query<SearchDocumentRow>(sql, params);

        const scored: ScoredDoc[] = [];
        for (const row of rows.rows) {
          const ranked = scoreDoc(row, queryTokens);
          if (ranked.score <= 0) continue;
          if (!(await isVisibleToPrincipal(ctx, principal, row))) continue;
          scored.push(ranked);
        }
        scored.sort((a, b) => b.score - a.score);
        const hits = scored.slice(0, limit).map(rowToHit);
        return jsonResponse({ query: parsed.q, hits });
      });

      ctx.app.get("/v1/search/suggest", async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) return jsonResponse({ error: "missing or invalid principal" }, 401);

        let parsed: z.infer<typeof suggestQuerySchema>;
        try {
          parsed = suggestQuerySchema.parse({
            q: c.req.query("q") ?? "",
            limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
          });
        } catch (error) {
          return mapServiceError(error);
        }

        try {
          await assertActorInOrg(ctx, principal);
        } catch (error) {
          return mapServiceError(error);
        }

        const limit = parsed.limit ?? 8;
        const tokens = tokenize(parsed.q);
        const rows = await ctx.service.db.query<SearchDocumentRow>(
          `SELECT * FROM search_documents
            WHERE org_id=? AND entity_type IN ('actor','channel','thread')
            ORDER BY updated_at DESC LIMIT 500`,
          [principal.orgId],
        );
        const suggestions: SearchSuggestion[] = [];
        for (const row of rows.rows) {
          const ranked = scoreDoc(row, tokens);
          if (ranked.score <= 0) continue;
          if (!(await isVisibleToPrincipal(ctx, principal, row))) continue;
          suggestions.push({
            entityType: row.entity_type as SearchEntityType,
            entityId: row.entity_id,
            label: row.title,
            actorType: (row.actor_type as "human" | "agent" | "app" | null) ?? null,
          });
          if (suggestions.length >= limit) break;
        }
        return jsonResponse({ query: parsed.q, suggestions });
      });
    },

    dispose() {
      unsubscribeBus?.();
      unregisterMemory?.();
    },
  };
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function assertActorInOrg(ctx: PluginRuntimeContext, principal: Principal): Promise<void> {
  const row = await ctx.service.db.query(
    "SELECT 1 FROM actors WHERE id=? AND org_id=? LIMIT 1",
    [principal.actorId, principal.orgId],
  );
  if (row.rows.length === 0) {
    throw new PermissionError("actor is not in org");
  }
}

async function backfillExisting(ctx: PluginRuntimeContext): Promise<void> {
  const actors = await ctx.service.db.query<{ id: string; org_id: string }>(
    "SELECT id, org_id FROM actors",
  );
  for (const a of actors.rows) await indexActor(ctx, a.org_id, a.id);
  const channels = await ctx.service.db.query<{ id: string; org_id: string }>(
    "SELECT id, org_id FROM channels",
  );
  for (const c of channels.rows) await indexChannelById(ctx, c.org_id, c.id);
  const threads = await ctx.service.db.query<{ id: string; org_id: string }>(
    "SELECT id, org_id FROM threads",
  );
  for (const t of threads.rows) await indexThreadById(ctx, t.org_id, t.id);
  const messages = await ctx.service.db.query<{
    id: string;
    org_id: string;
    stream_id: string;
    stream_type: string;
    actor_id: string;
    stream_seq: number;
    created_at: string;
    redacted: number;
  }>(
    "SELECT id, org_id, stream_id, stream_type, actor_id, stream_seq, created_at, redacted FROM messages",
  );
  for (const m of messages.rows) {
    if (Number(m.redacted) === 1) continue;
    await indexMessage(ctx, {
      type: "message.appended",
      orgId: m.org_id,
      streamId: m.stream_id,
      streamSeq: Number(m.stream_seq),
      createdAt: m.created_at,
      payload: {
        messageId: m.id,
        actorId: m.actor_id,
        streamType: m.stream_type as "channel" | "thread",
      },
    });
  }
}

// Suppress unused-import warning when consumers only use named exports.
export type { Principal };

// ────────────────────────────────────────────────────────────────────────────
// Internals exposed for white-box testing only.
// ────────────────────────────────────────────────────────────────────────────
export const _internals = {
  tokenize,
  scoreDoc,
  deterministicDocId,
  randomId: () => randomUUID().replace(/-/g, ""),
};
