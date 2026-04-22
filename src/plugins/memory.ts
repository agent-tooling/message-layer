import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PermissionError,
  ValidationError,
  principalSchema,
  type DomainEvent,
  type Principal,
  type StreamType,
} from "../types.js";
import type { PluginRuntimeContext, ServerPlugin } from "../plugins.js";

/**
 * `memory` — derived memory plugin.
 *
 * AGENTS.md alignment:
 *  - rule 1 ("messages are the center"): every memory unit is derived from a
 *    `message.appended` event; no parallel ingestion path.
 *  - rule 6 / 15 ("derived data must never be more visible than its source
 *    unless explicitly promoted"): the source `streamId`, `streamType`, and
 *    `visibility` are snapshotted at insertion time. Read paths delegate to
 *    `service.assertCanReadStream`. Promotion is gated behind the core
 *    `recordMemoryPromotion` hook which emits an audited event.
 *  - rule 7 ("structured messages"): only `text` parts are extracted; other
 *    typed parts (tool_call, ui, etc.) are ignored.
 *  - rule 8 ("actors are unified"): identity type is irrelevant to extraction
 *    or retrieval; humans, agents, and apps all flow through the same code.
 *  - rule 9 ("audit everything important"): promotion and redaction-driven
 *    deletion both flow through the core audit log. Local memory writes are
 *    not separately audited (they're a deterministic projection of an
 *    already-audited message append).
 *  - rule 12 ("event-driven, not tightly coupled"): the plugin only consumes
 *    events. Composition with other plugins (e.g. search) happens through a
 *    shared in-process registry so neither side hard-imports the other.
 *  - rule 16 ("consistency over cleverness"): v1 uses deterministic
 *    extraction (normalize + chunk + dedupe by hash + extract keywords).
 *    Agent-led summarization is intentionally deferred until the runtime
 *    grows safe nested-agent identity, quota, and isolation primitives.
 *
 * What is a "memory unit"?
 *
 *   A normalized, deduplicated text fragment with provenance back to one or
 *   more source messages. The `canonical_text` is what callers query against;
 *   `summary` is a short heuristic preview; `keywords` is a small token set
 *   used by the lexical retrieval ranker. Identical content posted twice
 *   inside the same stream collapses to a single unit (with an extra row in
 *   `memory_source_messages` linking the second message).
 *
 * Storage:
 *
 *   Plugin-owned tables, never touched by core:
 *     - `memory_units`            one row per (org, stream, content_hash)
 *     - `memory_source_messages`  N:1 edges from messages → memory unit
 */

// ── extraction primitives ───────────────────────────────────────────────────

/** Words ignored when computing keywords. Lowercase. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has",
  "have", "i", "in", "is", "it", "its", "of", "on", "or", "so", "than", "that",
  "the", "their", "them", "then", "there", "this", "to", "was", "we", "were",
  "with", "you", "your", "our", "us", "if", "do", "does", "did", "not", "no",
  "yes", "ok", "ya", "yeah", "uh", "um", "hmm", "lol",
]);

/** Conversational filler that does not deserve a memory unit on its own. */
const FILLER_PHRASES = new Set([
  "ok", "okay", "thanks", "thank you", "ty", "lol", "haha", "hey", "hi",
  "hello", "yes", "no", "yeah", "yep", "nope", "got it", "cool", "+1", "lgtm",
]);

function normalizeText(raw: string): string {
  // Collapse runs of whitespace, trim, and normalize basic punctuation so two
  // messages that differ only in spacing/case dedupe to the same unit.
  return raw
    .replace(/\s+/g, " ")
    .trim();
}

function isFiller(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.length <= 2) return true;
  if (FILLER_PHRASES.has(lower)) return true;
  return false;
}

/**
 * Split a long text part into discrete memory candidates. v1 splits on
 * sentence terminators while keeping things conservative — we never want to
 * shred a message into more than a handful of units.
 */
function chunkIntoCandidates(normalized: string): string[] {
  if (normalized.length <= 280) return [normalized];
  const sentences = normalized
    .split(/(?<=[.!?])\s+/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length === 0) return [normalized];
  // Keep at most 8 chunks per message to bound work on huge pastes.
  return sentences.slice(0, 8);
}

function summarize(canonical: string): string {
  if (canonical.length <= 140) return canonical;
  return `${canonical.slice(0, 137)}…`;
}

function extractKeywords(canonical: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawToken of canonical.toLowerCase().split(/[^a-z0-9_-]+/g)) {
    if (rawToken.length < 3) continue;
    if (STOPWORDS.has(rawToken)) continue;
    if (seen.has(rawToken)) continue;
    seen.add(rawToken);
    out.push(rawToken);
    if (out.length >= 16) break;
  }
  return out;
}

function contentHash(orgId: string, streamId: string, canonical: string): string {
  return createHash("sha256")
    .update(`${orgId}|${streamId}|${canonical.toLowerCase()}`)
    .digest("hex");
}

// ── plugin-owned schema ─────────────────────────────────────────────────────

const MEMORY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS memory_units (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    source_stream_id TEXT NOT NULL,
    source_stream_type TEXT NOT NULL CHECK (source_stream_type IN ('channel','thread')),
    source_visibility TEXT NOT NULL CHECK (source_visibility IN ('private','public')),
    content_hash TEXT NOT NULL,
    canonical_text TEXT NOT NULL,
    summary TEXT NOT NULL,
    keywords_json TEXT NOT NULL DEFAULT '[]',
    created_by_actor_id TEXT NOT NULL,
    promoted INTEGER NOT NULL DEFAULT 0,
    promoted_at TEXT,
    promoted_by_actor_id TEXT,
    promotion_summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (org_id, source_stream_id, content_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS memory_source_messages (
    memory_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (memory_id, message_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_units_stream ON memory_units(org_id, source_stream_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_units_promoted ON memory_units(org_id, promoted, promoted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_source_message ON memory_source_messages(message_id)`,
];

// ── row mapping ─────────────────────────────────────────────────────────────

type MemoryRow = {
  id: string;
  org_id: string;
  source_stream_id: string;
  source_stream_type: string;
  source_visibility: string;
  content_hash: string;
  canonical_text: string;
  summary: string;
  keywords_json: string;
  created_by_actor_id: string;
  promoted: number;
  promoted_at: string | null;
  promoted_by_actor_id: string | null;
  promotion_summary: string | null;
  created_at: string;
  updated_at: string;
};

export type MemoryUnit = {
  id: string;
  orgId: string;
  sourceStreamId: string;
  sourceStreamType: "channel" | "thread";
  sourceVisibility: "private" | "public";
  canonicalText: string;
  summary: string;
  keywords: string[];
  createdByActorId: string;
  sourceMessageIds: string[];
  promoted: boolean;
  promotedAt: string | null;
  promotedByActorId: string | null;
  promotionSummary: string | null;
  createdAt: string;
  updatedAt: string;
};

function parseKeywords(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function mapRow(row: MemoryRow, sourceMessageIds: string[]): MemoryUnit {
  return {
    id: row.id,
    orgId: row.org_id,
    sourceStreamId: row.source_stream_id,
    sourceStreamType: row.source_stream_type as "channel" | "thread",
    sourceVisibility: row.source_visibility as "private" | "public",
    canonicalText: row.canonical_text,
    summary: row.summary,
    keywords: parseKeywords(row.keywords_json),
    createdByActorId: row.created_by_actor_id,
    sourceMessageIds,
    promoted: Number(row.promoted) === 1,
    promotedAt: row.promoted_at,
    promotedByActorId: row.promoted_by_actor_id,
    promotionSummary: row.promotion_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── helpers shared with HTTP layer ──────────────────────────────────────────

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
    return jsonResponse({ error: "invalid request", code: "VALIDATION" }, 400);
  }
  return jsonResponse({ error: err?.message ?? "unexpected error", code: "ERROR" }, 500);
}

async function loadSourceMessageIds(
  ctx: PluginRuntimeContext,
  memoryIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (memoryIds.length === 0) return out;
  const placeholders = memoryIds.map(() => "?").join(",");
  const rows = await ctx.service.db.query<{ memory_id: string; message_id: string }>(
    `SELECT memory_id, message_id FROM memory_source_messages WHERE memory_id IN (${placeholders}) ORDER BY created_at ASC`,
    memoryIds,
  );
  for (const row of rows.rows) {
    const list = out.get(row.memory_id) ?? [];
    list.push(row.message_id);
    out.set(row.memory_id, list);
  }
  return out;
}

async function listMemoryRowsForStream(
  ctx: PluginRuntimeContext,
  orgId: string,
  streamId: string,
): Promise<MemoryUnit[]> {
  const rows = await ctx.service.db.query<MemoryRow>(
    `SELECT * FROM memory_units WHERE org_id=? AND source_stream_id=? ORDER BY created_at ASC`,
    [orgId, streamId],
  );
  const sources = await loadSourceMessageIds(
    ctx,
    rows.rows.map((r) => r.id),
  );
  return rows.rows.map((row) => mapRow(row, sources.get(row.id) ?? []));
}

async function listPromotedMemoryRows(
  ctx: PluginRuntimeContext,
  orgId: string,
): Promise<MemoryUnit[]> {
  const rows = await ctx.service.db.query<MemoryRow>(
    `SELECT * FROM memory_units WHERE org_id=? AND promoted=1 ORDER BY promoted_at ASC`,
    [orgId],
  );
  const sources = await loadSourceMessageIds(
    ctx,
    rows.rows.map((r) => r.id),
  );
  return rows.rows.map((row) => mapRow(row, sources.get(row.id) ?? []));
}

async function loadMemoryById(
  ctx: PluginRuntimeContext,
  orgId: string,
  memoryId: string,
): Promise<MemoryUnit | null> {
  const rows = await ctx.service.db.query<MemoryRow>(
    `SELECT * FROM memory_units WHERE id=? AND org_id=?`,
    [memoryId, orgId],
  );
  if (rows.rows.length === 0) return null;
  const sources = await loadSourceMessageIds(ctx, [memoryId]);
  return mapRow(rows.rows[0], sources.get(memoryId) ?? []);
}

// ── ranking ────────────────────────────────────────────────────────────────

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/g)
    .filter((tok) => tok.length >= 2);
}

/**
 * Score a memory unit against a query. Deterministic baseline:
 *   - +5 per keyword exact-match
 *   - +2 per keyword prefix-match
 *   - +3 if any token appears in `canonical_text` (whole-word)
 *   - +1 small recency bonus (0..1)
 */
function scoreUnit(unit: MemoryUnit, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const keywordSet = new Set(unit.keywords);
  const lower = unit.canonicalText.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (keywordSet.has(token)) {
      score += 5;
      continue;
    }
    let prefixHit = false;
    for (const kw of unit.keywords) {
      if (kw.startsWith(token) || token.startsWith(kw)) {
        prefixHit = true;
        break;
      }
    }
    if (prefixHit) score += 2;
    if (new RegExp(`\\b${escapeRegExp(token)}\\b`).test(lower)) {
      score += 3;
    }
  }
  // Recency bonus (newer first), bounded.
  const ageMs = Date.now() - new Date(unit.updatedAt).getTime();
  const days = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
  score += Math.max(0, 1 - days / 30);
  return score;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── composition: memory <-> search ─────────────────────────────────────────

/**
 * Internal in-process composition channel. The search plugin can register a
 * provider that the memory plugin notifies whenever a unit is added, updated,
 * promoted, or removed. Search remains optional: if no provider is registered
 * the memory plugin functions in standalone mode.
 *
 * AGENTS.md alignment: keeps both plugins independently runnable (rule 12 +
 * rule 16). Neither side hard-imports the other; only this shared module
 * type lives in the memory plugin's public surface.
 */
export type MemoryIndexEvent =
  | { kind: "upsert"; unit: MemoryUnit }
  | { kind: "delete"; orgId: string; memoryId: string };

export type MemoryIndexProvider = (event: MemoryIndexEvent) => void | Promise<void>;

const MEMORY_INDEX_GLOBAL_KEY = "__messageLayerMemoryIndexProviders";
type GlobalScope = typeof globalThis & {
  [MEMORY_INDEX_GLOBAL_KEY]?: Set<MemoryIndexProvider>;
};

function providerSet(): Set<MemoryIndexProvider> {
  const g = globalThis as GlobalScope;
  if (!g[MEMORY_INDEX_GLOBAL_KEY]) {
    g[MEMORY_INDEX_GLOBAL_KEY] = new Set<MemoryIndexProvider>();
  }
  return g[MEMORY_INDEX_GLOBAL_KEY]!;
}

/**
 * Register a function that wants to receive `MemoryIndexEvent`s for any
 * memory unit lifecycle change (insert/update/delete). Returns an
 * `unregister` callback. Used by the `search` plugin to keep its document
 * index in sync with derived memory.
 */
export function registerMemoryIndexProvider(provider: MemoryIndexProvider): () => void {
  const set = providerSet();
  set.add(provider);
  return () => {
    set.delete(provider);
  };
}

async function notifyProviders(event: MemoryIndexEvent): Promise<void> {
  const set = providerSet();
  for (const provider of set) {
    try {
      await provider(event);
    } catch {
      // composition is best-effort; never break ingestion when a downstream
      // index is misbehaving.
    }
  }
}

// ── source-stream resolution ───────────────────────────────────────────────

type ResolvedStream = {
  visibility: "private" | "public";
  streamType: "channel" | "thread";
};

async function resolveSourceStream(
  ctx: PluginRuntimeContext,
  streamId: string,
): Promise<ResolvedStream | null> {
  const channel = await ctx.service.db.query<{ visibility: string }>(
    "SELECT visibility FROM channels WHERE id=?",
    [streamId],
  );
  if (channel.rows[0]) {
    return {
      visibility: channel.rows[0].visibility as "private" | "public",
      streamType: "channel",
    };
  }
  const thread = await ctx.service.db.query<{ visibility: string }>(
    "SELECT visibility FROM threads WHERE id=?",
    [streamId],
  );
  if (thread.rows[0]) {
    return {
      visibility: thread.rows[0].visibility as "private" | "public",
      streamType: "thread",
    };
  }
  return null;
}

async function hydrateTextParts(ctx: PluginRuntimeContext, messageId: string): Promise<string[]> {
  const rows = await ctx.service.db.query<{ part_type: string; payload_json: string | null }>(
    "SELECT part_type, payload_json FROM message_parts WHERE message_id=? ORDER BY part_index ASC",
    [messageId],
  );
  const out: string[] = [];
  for (const r of rows.rows) {
    if (r.part_type !== "text" || !r.payload_json) continue;
    try {
      const payload = JSON.parse(r.payload_json) as { text?: unknown };
      if (typeof payload.text === "string" && payload.text.trim().length > 0) {
        out.push(payload.text);
      }
    } catch {
      continue;
    }
  }
  return out;
}

// ── ingestion ──────────────────────────────────────────────────────────────

async function ingestMessageAppended(
  ctx: PluginRuntimeContext,
  event: DomainEvent,
): Promise<void> {
  const streamId = event.streamId;
  if (!streamId) return;
  const payload = event.payload as { messageId?: string; actorId?: string };
  const messageId = payload.messageId;
  const actorId = payload.actorId;
  if (!messageId || !actorId) return;

  const texts = await hydrateTextParts(ctx, messageId);
  if (texts.length === 0) return;

  const resolved = await resolveSourceStream(ctx, streamId);
  if (!resolved) return;

  const now = new Date().toISOString();
  const newOrUpdated: MemoryUnit[] = [];

  for (const rawText of texts) {
    const candidates = chunkIntoCandidates(normalizeText(rawText));
    for (const candidate of candidates) {
      if (isFiller(candidate)) continue;
      const canonical = candidate;
      const hash = contentHash(event.orgId, streamId, canonical);
      const existing = await ctx.service.db.query<MemoryRow>(
        `SELECT * FROM memory_units WHERE org_id=? AND source_stream_id=? AND content_hash=?`,
        [event.orgId, streamId, hash],
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        await ctx.service.db.query(
          `INSERT INTO memory_source_messages(memory_id,org_id,message_id,actor_id,created_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT (memory_id, message_id) DO NOTHING`,
          [row.id, event.orgId, messageId, actorId, now],
        );
        await ctx.service.db.query(
          `UPDATE memory_units SET updated_at=? WHERE id=?`,
          [now, row.id],
        );
        const sources = await loadSourceMessageIds(ctx, [row.id]);
        newOrUpdated.push(mapRow({ ...row, updated_at: now }, sources.get(row.id) ?? []));
        continue;
      }

      const id = randomUUID().replace(/-/g, "");
      const summary = summarize(canonical);
      const keywords = extractKeywords(canonical);
      await ctx.service.db.query(
        `INSERT INTO memory_units(
            id,org_id,source_stream_id,source_stream_type,source_visibility,
            content_hash,canonical_text,summary,keywords_json,
            created_by_actor_id,promoted,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`,
        [
          id,
          event.orgId,
          streamId,
          resolved.streamType,
          resolved.visibility,
          hash,
          canonical,
          summary,
          JSON.stringify(keywords),
          actorId,
          now,
          now,
        ],
      );
      await ctx.service.db.query(
        `INSERT INTO memory_source_messages(memory_id,org_id,message_id,actor_id,created_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT (memory_id, message_id) DO NOTHING`,
        [id, event.orgId, messageId, actorId, now],
      );
      newOrUpdated.push({
        id,
        orgId: event.orgId,
        sourceStreamId: streamId,
        sourceStreamType: resolved.streamType,
        sourceVisibility: resolved.visibility,
        canonicalText: canonical,
        summary,
        keywords,
        createdByActorId: actorId,
        sourceMessageIds: [messageId],
        promoted: false,
        promotedAt: null,
        promotedByActorId: null,
        promotionSummary: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  for (const unit of newOrUpdated) {
    await notifyProviders({ kind: "upsert", unit });
  }
}

async function applyPromotion(ctx: PluginRuntimeContext, event: DomainEvent): Promise<void> {
  const payload = event.payload as {
    memoryId?: string;
    promotedByActorId?: string;
    summary?: string | null;
    promotedAt?: string;
  };
  if (!payload.memoryId) return;
  await ctx.service.db.query(
    `UPDATE memory_units
        SET promoted=1, promoted_at=?, promoted_by_actor_id=?, promotion_summary=?, updated_at=?
      WHERE id=? AND org_id=?`,
    [
      payload.promotedAt ?? new Date().toISOString(),
      payload.promotedByActorId ?? null,
      payload.summary ?? null,
      payload.promotedAt ?? new Date().toISOString(),
      payload.memoryId,
      event.orgId,
    ],
  );
  const unit = await loadMemoryById(ctx, event.orgId, payload.memoryId);
  if (unit) await notifyProviders({ kind: "upsert", unit });
}

async function applyMessageRedaction(
  ctx: PluginRuntimeContext,
  event: DomainEvent,
): Promise<void> {
  const payload = event.payload as { messageId?: string };
  const messageId = payload.messageId;
  if (!messageId) return;

  // Find affected memory units. A unit derived solely from the redacted
  // message must be deleted; units shared with other still-live messages
  // simply lose this provenance edge.
  const linked = await ctx.service.db.query<{ memory_id: string }>(
    `SELECT memory_id FROM memory_source_messages WHERE message_id=? AND org_id=?`,
    [messageId, event.orgId],
  );
  if (linked.rows.length === 0) return;

  await ctx.service.db.query(
    `DELETE FROM memory_source_messages WHERE message_id=? AND org_id=?`,
    [messageId, event.orgId],
  );

  for (const row of linked.rows) {
    const remaining = await ctx.service.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM memory_source_messages WHERE memory_id=?`,
      [row.memory_id],
    );
    const count = Number(remaining.rows[0]?.n ?? 0);
    if (count === 0) {
      await ctx.service.db.query(`DELETE FROM memory_units WHERE id=? AND org_id=?`, [
        row.memory_id,
        event.orgId,
      ]);
      await notifyProviders({ kind: "delete", orgId: event.orgId, memoryId: row.memory_id });
    } else {
      const unit = await loadMemoryById(ctx, event.orgId, row.memory_id);
      if (unit) await notifyProviders({ kind: "upsert", unit });
    }
  }
}

// ── HTTP routes ─────────────────────────────────────────────────────────────

const promoteBodySchema = z.object({ summary: z.string().max(500).optional() });

export function memoryPlugin(_options?: Record<string, unknown>): ServerPlugin {
  let unsubscribe: (() => void) | undefined;

  return {
    name: "memory",
    schemaSql: { name: "memory", sql: MEMORY_SCHEMA },

    async setup(ctx) {
      unsubscribe = ctx.bus.subscribe(async (event) => {
        if (event.type === "message.appended") {
          await ingestMessageAppended(ctx, event);
          return;
        }
        if (event.type === "memory.promoted") {
          await applyPromotion(ctx, event);
          return;
        }
        if (event.type === "message.redacted") {
          await applyMessageRedaction(ctx, event);
        }
      });
    },

    registerRoutes(ctx) {
      // List memory for a stream (or org-wide promoted memory).
      ctx.app.get("/v1/memory", async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) return jsonResponse({ error: "missing or invalid principal" }, 401);

        const streamId = c.req.query("streamId");
        const promotedOnly = c.req.query("promoted") === "true";

        if (streamId) {
          try {
            await ctx.service.assertCanReadStream(principal, streamId);
          } catch (error) {
            return mapServiceError(error);
          }
          let units = await listMemoryRowsForStream(ctx, principal.orgId, streamId);
          if (promotedOnly) units = units.filter((u) => u.promoted);
          return jsonResponse({ units });
        }

        if (!promotedOnly) {
          return jsonResponse(
            { error: "either streamId or promoted=true is required", code: "VALIDATION" },
            400,
          );
        }

        const inOrg = await ctx.service.db.query(
          "SELECT 1 FROM actors WHERE id=? AND org_id=?",
          [principal.actorId, principal.orgId],
        );
        if (inOrg.rows.length === 0) {
          return jsonResponse({ error: "actor is not in org", code: "PERMISSION_DENIED" }, 403);
        }
        const units = await listPromotedMemoryRows(ctx, principal.orgId);
        return jsonResponse({ units });
      });

      // Search memory across visible streams (lexical baseline).
      ctx.app.get("/v1/memory/search", async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) return jsonResponse({ error: "missing or invalid principal" }, 401);

        const q = (c.req.query("q") ?? "").trim();
        if (q.length === 0) {
          return jsonResponse({ error: "q is required", code: "VALIDATION" }, 400);
        }
        const limit = clampLimit(c.req.query("limit"));
        const streamIdFilter = c.req.query("streamId");

        try {
          await assertActorInOrg(ctx, principal);
        } catch (error) {
          return mapServiceError(error);
        }

        // Determine which streams the principal can see, then filter the
        // candidate set to those streams plus org-wide promoted units. We
        // do this in TS so the privacy logic stays in one place
        // (`assertCanReadStream`) rather than fragmenting into SQL.
        const visibleStreamIds = await visibleStreamIdsFor(ctx, principal, streamIdFilter ?? null);

        // Gather candidates: per visible stream + promoted org-wide.
        const visibleSet = new Set(visibleStreamIds);
        const candidates = new Map<string, MemoryUnit>();
        for (const sid of visibleStreamIds) {
          const units = await listMemoryRowsForStream(ctx, principal.orgId, sid);
          for (const unit of units) candidates.set(unit.id, unit);
        }
        const promoted = await listPromotedMemoryRows(ctx, principal.orgId);
        for (const unit of promoted) {
          if (visibleSet.has(unit.sourceStreamId)) {
            candidates.set(unit.id, unit);
            continue;
          }
          // Promoted entries are readable by any org member regardless of
          // source stream readability (that's the whole point of promotion).
          candidates.set(unit.id, unit);
        }

        const queryTokens = tokenize(q);
        const ranked = [...candidates.values()]
          .map((unit) => ({ unit, score: scoreUnit(unit, queryTokens) }))
          .filter((hit) => hit.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map(({ unit, score }) => ({
            unit,
            score: Number(score.toFixed(3)),
            highlights: highlightMatches(unit.canonicalText, queryTokens),
          }));
        return jsonResponse({ query: q, hits: ranked });
      });

      // Fetch a single memory unit by id.
      ctx.app.get("/v1/memory/:memoryId", async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) return jsonResponse({ error: "missing or invalid principal" }, 401);

        const memoryId = c.req.param("memoryId");
        const unit = await loadMemoryById(ctx, principal.orgId, memoryId);
        if (!unit) return jsonResponse({ error: "not found", code: "NOT_FOUND" }, 404);

        if (!unit.promoted) {
          try {
            await ctx.service.assertCanReadStream(
              principal,
              unit.sourceStreamId,
              unit.sourceStreamType,
            );
          } catch (error) {
            return mapServiceError(error);
          }
        } else {
          try {
            await assertActorInOrg(ctx, principal);
          } catch (error) {
            return mapServiceError(error);
          }
        }
        return jsonResponse({ unit });
      });

      // Promote a memory unit org-wide via the core hook.
      ctx.app.post("/v1/memory/:memoryId/promote", async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) return jsonResponse({ error: "missing or invalid principal" }, 401);

        const memoryId = c.req.param("memoryId");
        const unit = await loadMemoryById(ctx, principal.orgId, memoryId);
        if (!unit) return jsonResponse({ error: "not found", code: "NOT_FOUND" }, 404);
        if (unit.promoted) return jsonResponse({ unit });

        let summary: string | undefined;
        try {
          const body = await c.req.json().catch(() => ({}));
          const parsed = promoteBodySchema.parse(body ?? {});
          summary = parsed.summary;
        } catch (error) {
          return mapServiceError(error);
        }

        try {
          await ctx.service.recordMemoryPromotion(principal, {
            memoryId,
            sourceStreamId: unit.sourceStreamId,
            sourceStreamType: unit.sourceStreamType,
            summary,
          });
        } catch (error) {
          return mapServiceError(error);
        }
        const updated = await loadMemoryById(ctx, principal.orgId, memoryId);
        return jsonResponse({ unit: updated ?? unit });
      });
    },

    dispose() {
      unsubscribe?.();
    },
  };
}

function clampLimit(raw: string | undefined): number {
  const n = Number(raw ?? "20");
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(100, Math.floor(n));
}

async function assertActorInOrg(ctx: PluginRuntimeContext, principal: Principal): Promise<void> {
  const row = await ctx.service.db.query(
    "SELECT 1 FROM actors WHERE id=? AND org_id=?",
    [principal.actorId, principal.orgId],
  );
  if (row.rows.length === 0) {
    throw new PermissionError("actor is not in org");
  }
}

/**
 * Resolve the set of source streamIds the principal can currently read.
 * When `streamIdFilter` is provided we narrow to that single stream (and
 * still enforce read permission). Otherwise we enumerate every channel
 * (public org-wide, or private with membership) plus every thread inside
 * those channels.
 */
async function visibleStreamIdsFor(
  ctx: PluginRuntimeContext,
  principal: Principal,
  streamIdFilter: string | null,
): Promise<string[]> {
  if (streamIdFilter) {
    try {
      await ctx.service.assertCanReadStream(principal, streamIdFilter);
      return [streamIdFilter];
    } catch (error) {
      if ((error as { code?: string }).code === "PERMISSION_DENIED") return [];
      throw error;
    }
  }
  const channels = await ctx.service.db.query<{ id: string; visibility: string }>(
    `SELECT c.id, c.visibility
       FROM channels c
      WHERE c.org_id=?
        AND (
          c.visibility='public'
          OR EXISTS(SELECT 1 FROM memberships m WHERE m.channel_id=c.id AND m.actor_id=?)
        )`,
    [principal.orgId, principal.actorId],
  );
  const channelIds = channels.rows.map((r) => r.id);
  if (channelIds.length === 0) return [];
  const placeholders = channelIds.map(() => "?").join(",");
  const threads = await ctx.service.db.query<{ id: string }>(
    `SELECT id FROM threads WHERE org_id=? AND channel_id IN (${placeholders})`,
    [principal.orgId, ...channelIds],
  );
  return [...channelIds, ...threads.rows.map((r) => r.id)];
}

function highlightMatches(canonical: string, queryTokens: string[]): string[] {
  if (queryTokens.length === 0) return [];
  const out: string[] = [];
  const lower = canonical.toLowerCase();
  for (const token of queryTokens) {
    const idx = lower.indexOf(token);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 24);
    const end = Math.min(canonical.length, idx + token.length + 24);
    const slice = canonical.slice(start, end);
    out.push(start > 0 ? `…${slice}` : slice);
    if (out.length >= 3) break;
  }
  return out;
}

// ── exports for testing/composition ────────────────────────────────────────

export const _internals = {
  normalizeText,
  chunkIntoCandidates,
  extractKeywords,
  isFiller,
  contentHash,
  scoreUnit,
};

// Suppress unused-import warning when consumers only use the named export.
export type { StreamType };
