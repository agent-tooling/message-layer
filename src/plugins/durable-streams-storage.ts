/**
 * durable-streams-storage plugin
 *
 * A variant of the durable-streams plugin where **chunk data is written to
 * the blob `StorageAdapter`** (memory / local-fs / S3) rather than SQL rows.
 * SQL is used only for stream metadata and offset tracking, keeping the DB
 * lean for workloads with large payloads (streaming LLM output, log tails,
 * binary frames, etc.).
 *
 * The same `StorageAdapter` that backs artifact blobs is reused here, so
 * configuring S3 for artifacts automatically gives S3-backed durable streams.
 *
 * Key layout inside the storage adapter:
 *   {orgId}/dss/{streamId}/chunk-{offset:010d}   ← each chunk's raw bytes
 *   {orgId}/dss/{streamId}/manifest.json          ← written on close
 *
 * Routes mounted at `/v1/durable-streams-storage` (configurable via `mountPath`):
 *   POST   /                        create stream
 *   GET    /:id/head                stream metadata
 *   POST   /:id/chunks              append chunk(s) → stored in StorageAdapter
 *   GET    /:id/read?offset=N       batch-read chunks from storage
 *   GET    /:id/tail                SSE tail (long-poll, real-time)
 *   POST   /:id/close               close stream + write manifest
 *   POST   /:id/commit              assemble + post all chunks as a single message
 *
 * For local e2e testing without S3 or Docker, use `InMemoryStorageAdapter`
 * (already the default for `artifacts: { kind: "memory" }`) — the plugin
 * uses `ctx.service.storage` which will be whatever adapter the server was
 * booted with.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PermissionError,
  ValidationError,
  principalSchema,
  streamTypeSchema,
  type Principal,
  type StreamType,
} from "../types.js";
import type { ServerPlugin } from "../plugins.js";
import type { StorageAdapter } from "../storage.js";

// ── SQL schema ────────────────────────────────────────────────────────────────

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS dss_streams (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL,
    actor_id      TEXT NOT NULL,
    target_stream_id   TEXT,
    target_stream_type TEXT,
    content_type  TEXT NOT NULL DEFAULT 'text/plain; charset=utf-8',
    chunk_count   INTEGER NOT NULL DEFAULT 0,
    byte_count    INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'open',
    committed_message_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    closed_at     TEXT,
    FOREIGN KEY (org_id) REFERENCES organizations(id),
    FOREIGN KEY (actor_id) REFERENCES actors(id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_dss_streams_org_actor ON dss_streams(org_id, actor_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_dss_streams_org_target ON dss_streams(org_id, target_stream_id)",
];

// ── Row types ─────────────────────────────────────────────────────────────────

type DssStreamRow = {
  id: string;
  org_id: string;
  actor_id: string;
  target_stream_id: string | null;
  target_stream_type: StreamType | null;
  content_type: string;
  chunk_count: number;
  byte_count: number;
  status: "open" | "closed" | "committed";
  committed_message_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

// ── Zod schemas ───────────────────────────────────────────────────────────────

const createStreamBody = z.object({
  targetStreamId: z.string().min(1).optional(),
  targetStreamType: streamTypeSchema.optional(),
  contentType: z.string().min(1).max(120).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const appendChunksBody = z.object({
  /**
   * Each chunk is a text string. For binary content, base64-encode it and
   * set `contentType` to the appropriate MIME type.
   */
  chunks: z.array(z.object({ text: z.string() })).min(1),
});

const commitBody = z.object({
  idempotencyKey: z.string().min(1).max(120).optional(),
});

const closeBody = z.object({
  reason: z.string().max(500).optional(),
});

// ── Storage key helpers ───────────────────────────────────────────────────────

function chunkKey(orgId: string, streamId: string, offset: number): string {
  // Zero-pad to 10 digits so lexicographic and numeric orders match
  return `${orgId}/dss/${streamId}/chunk-${String(offset).padStart(10, "0")}`;
}

function manifestKey(orgId: string, streamId: string): string {
  return `${orgId}/dss/${streamId}/manifest.json`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function safeJson(raw: string): Record<string, unknown> {
  try {
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof PermissionError) {
    return new Response(JSON.stringify({ error: error.message, code: "PERMISSION_DENIED" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  if (error instanceof ValidationError || error instanceof z.ZodError) {
    const msg =
      error instanceof z.ZodError
        ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        : error.message;
    return new Response(JSON.stringify({ error: msg, code: "VALIDATION" }), {
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

// ── Plugin factory ────────────────────────────────────────────────────────────

export function durableStreamsStoragePlugin(
  options?: Record<string, unknown>,
): ServerPlugin {
  const mountPath =
    typeof options?.mountPath === "string"
      ? options.mountPath
      : "/v1/durable-streams-storage";
  const longPollTimeoutMs = Number(options?.longPollTimeoutMs ?? 30_000);

  // In-process waiters for SSE tail
  const waiters = new Map<string, Set<() => void>>();

  function notify(streamId: string): void {
    const set = waiters.get(streamId);
    if (!set) return;
    for (const cb of set) cb();
    waiters.delete(streamId);
  }

  function waitForUpdate(streamId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);
      const bucket = waiters.get(streamId) ?? new Set<() => void>();
      waiters.set(streamId, bucket);
      const onWake = () => {
        cleanup();
        resolve();
      };
      bucket.add(onWake);
      const abortListener = () => {
        cleanup();
        resolve();
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      function cleanup() {
        clearTimeout(timer);
        const cur = waiters.get(streamId);
        cur?.delete(onWake);
        if (cur?.size === 0) waiters.delete(streamId);
        signal?.removeEventListener("abort", abortListener);
      }
    });
  }

  return {
    name: "durable-streams-storage",
    schemaSql: { name: "durable-streams-storage", sql: SCHEMA_SQL },

    registerRoutes(ctx) {
      const storage: StorageAdapter = ctx.service.storage;

      // ── helpers scoped to the plugin context ─────────────────────────────

      async function assertPrincipalInOrg(principal: Principal): Promise<void> {
        const res = await ctx.db.query<{ ok: number }>(
          "SELECT 1 AS ok FROM actors WHERE id=? AND org_id=? LIMIT 1",
          [principal.actorId, principal.orgId],
        );
        if (!res.rows[0]) throw new PermissionError("actor is not in org");
      }

      async function loadStream(id: string): Promise<DssStreamRow | null> {
        const res = await ctx.db.query<DssStreamRow>(
          `SELECT id,org_id,actor_id,target_stream_id,target_stream_type,
                  content_type,chunk_count,byte_count,status,committed_message_id,
                  metadata_json,created_at,updated_at,closed_at
           FROM dss_streams WHERE id=? LIMIT 1`,
          [id],
        );
        return res.rows[0] ?? null;
      }

      function streamVisibleToPrincipal(row: DssStreamRow, principal: Principal): boolean {
        return row.actor_id === principal.actorId;
      }

      async function assertReadAccess(row: DssStreamRow, principal: Principal): Promise<void> {
        if (row.org_id !== principal.orgId) throw new PermissionError("stream not found");
        if (streamVisibleToPrincipal(row, principal)) return;
        // Delegate to target stream visibility check if linked
        if (row.target_stream_id) {
          await ctx.service.assertCanReadStream(principal, row.target_stream_id);
          return;
        }
        const hasGrant = await ctx.service.checkGrant(principal.orgId, principal.actorId, "durable_stream:read");
        if (!hasGrant) throw new PermissionError("missing durable_stream:read");
      }

      async function assertWriteAccess(row: DssStreamRow, principal: Principal): Promise<void> {
        if (row.org_id !== principal.orgId) throw new PermissionError("stream not found");
        if (streamVisibleToPrincipal(row, principal)) return;
        const hasGrant = await ctx.service.checkGrant(principal.orgId, principal.actorId, "durable_stream:write");
        if (!hasGrant) throw new PermissionError("missing durable_stream:write");
      }

      // ── POST / — create stream ────────────────────────────────────────────

      ctx.app.post(mountPath, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        try {
          await assertPrincipalInOrg(principal);
          const body = createStreamBody.parse(await c.req.json().catch(() => ({})));
          if (
            (body.targetStreamId && !body.targetStreamType) ||
            (!body.targetStreamId && body.targetStreamType)
          ) {
            throw new ValidationError("targetStreamId and targetStreamType must be provided together");
          }
          if (body.targetStreamId && body.targetStreamType) {
            await ctx.service.assertCanReadStream(principal, body.targetStreamId);
          }
          const id = randomUUID().replaceAll("-", "");
          const now = new Date().toISOString();
          await ctx.db.query(
            `INSERT INTO dss_streams(
               id,org_id,actor_id,target_stream_id,target_stream_type,
               content_type,chunk_count,byte_count,status,metadata_json,created_at,updated_at
             ) VALUES (?,?,?,?,?,?,0,0,'open',?,?,?)`,
            [
              id,
              principal.orgId,
              principal.actorId,
              body.targetStreamId ?? null,
              body.targetStreamType ?? null,
              body.contentType ?? "text/plain; charset=utf-8",
              JSON.stringify(body.metadata ?? {}),
              now,
              now,
            ],
          );
          return c.json({ durableStreamId: id, status: "open", chunkCount: 0 });
        } catch (err) {
          return errorResponse(err);
        }
      });

      // ── GET /:id/head — stream metadata ──────────────────────────────────

      ctx.app.get(`${mountPath}/:id/head`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        try {
          await assertPrincipalInOrg(principal);
          const row = await loadStream(c.req.param("id"));
          if (!row) return c.json({ error: "stream not found", code: "NOT_FOUND" }, 404);
          await assertReadAccess(row, principal);
          return c.json({
            durableStreamId: row.id,
            status: row.status,
            chunkCount: row.chunk_count,
            byteCount: row.byte_count,
            contentType: row.content_type,
            targetStreamId: row.target_stream_id,
            targetStreamType: row.target_stream_type,
            committedMessageId: row.committed_message_id,
            metadata: safeJson(row.metadata_json),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            closedAt: row.closed_at,
          });
        } catch (err) {
          return errorResponse(err);
        }
      });

      // ── POST /:id/chunks — append ─────────────────────────────────────────

      ctx.app.post(`${mountPath}/:id/chunks`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        try {
          await assertPrincipalInOrg(principal);
          const streamId = c.req.param("id");
          const row = await loadStream(streamId);
          if (!row) return c.json({ error: "stream not found", code: "NOT_FOUND" }, 404);
          await assertWriteAccess(row, principal);
          if (row.status !== "open") throw new ValidationError("stream is closed");

          const body = appendChunksBody.parse(await c.req.json());
          let offset = Number(row.chunk_count);
          let totalBytes = Number(row.byte_count);
          const now = new Date().toISOString();

          for (const chunk of body.chunks) {
            offset += 1;
            const bytes = Buffer.from(chunk.text, "utf8");
            await storage.put(chunkKey(principal.orgId, streamId, offset), bytes, {
              contentType: row.content_type,
            });
            totalBytes += bytes.byteLength;
          }

          await ctx.db.query(
            "UPDATE dss_streams SET chunk_count=?, byte_count=?, updated_at=? WHERE id=?",
            [offset, totalBytes, now, streamId],
          );
          notify(streamId);
          return c.json({ durableStreamId: streamId, appended: body.chunks.length, offset, byteCount: totalBytes });
        } catch (err) {
          return errorResponse(err);
        }
      });

      // ── GET /:id/read?offset=N&limit=L — batch read ───────────────────────

      ctx.app.get(`${mountPath}/:id/read`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        try {
          await assertPrincipalInOrg(principal);
          const streamId = c.req.param("id");
          const row = await loadStream(streamId);
          if (!row) return c.json({ error: "stream not found", code: "NOT_FOUND" }, 404);
          await assertReadAccess(row, principal);

          const fromOffset = Math.max(0, Number(c.req.query("offset") ?? "0"));
          const rawLimit = Number(c.req.query("limit") ?? "200");
          const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(2000, rawLimit)) : 200;
          const live = c.req.query("live") === "true";
          const timeoutMs = Math.max(
            50,
            Math.min(120_000, Number(c.req.query("timeoutMs") ?? longPollTimeoutMs)),
          );

          async function readBatch() {
            const total = Number(row!.chunk_count);
            const chunks: Array<{ offset: number; text: string }> = [];
            for (let i = fromOffset + 1; i <= Math.min(fromOffset + limit, total); i++) {
              const obj = await storage.get(chunkKey(principal!.orgId, streamId, i));
              if (obj) chunks.push({ offset: i, text: obj.content.toString("utf8") });
            }
            return chunks;
          }

          let chunks = await readBatch();

          if (chunks.length === 0 && live && row.status === "open") {
            await waitForUpdate(streamId, timeoutMs, c.req.raw.signal);
            // Re-load row to get the latest chunk_count
            const reloaded = await loadStream(streamId);
            if (reloaded) Object.assign(row, reloaded);
            chunks = await readBatch();
          }

          const nextOffset = chunks.length > 0 ? chunks[chunks.length - 1]!.offset : fromOffset;
          const reloaded = await loadStream(streamId);
          const latestOffset = Number(reloaded?.chunk_count ?? row.chunk_count);
          return c.json({
            durableStreamId: streamId,
            status: reloaded?.status ?? row.status,
            fromOffset,
            nextOffset,
            upToDate: nextOffset >= latestOffset,
            chunks,
          });
        } catch (err) {
          return errorResponse(err);
        }
      });

      // ── GET /:id/tail — SSE live tail ─────────────────────────────────────

      ctx.app.get(`${mountPath}/:id/tail`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        try {
          await assertPrincipalInOrg(principal);
          const streamId = c.req.param("id");
          const row = await loadStream(streamId);
          if (!row) return c.json({ error: "stream not found", code: "NOT_FOUND" }, 404);
          await assertReadAccess(row, principal);

          const startOffset = Math.max(0, Number(c.req.query("offset") ?? "0"));
          const encoder = new TextEncoder();

          const body = new ReadableStream<Uint8Array>({
            start: async (controller) => {
              let offset = startOffset;
              const signal = c.req.raw.signal;

              const emit = (event: string, data: Record<string, unknown>) => {
                controller.enqueue(
                  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
                );
              };

              try {
                emit("ready", { durableStreamId: streamId, offset });
                while (!signal.aborted) {
                  const current = await loadStream(streamId);
                  if (!current) break;
                  const total = Number(current.chunk_count);

                  if (offset < total) {
                    const batch: Array<{ offset: number; text: string }> = [];
                    for (let i = offset + 1; i <= total; i++) {
                      const obj = await storage.get(chunkKey(principal.orgId, streamId, i));
                      if (obj) batch.push({ offset: i, text: obj.content.toString("utf8") });
                    }
                    if (batch.length > 0) {
                      offset = batch[batch.length - 1]!.offset;
                      emit("chunks", { offset, items: batch });
                      continue;
                    }
                  }

                  if (current.status !== "open") {
                    emit("eof", { durableStreamId: streamId, offset });
                    break;
                  }
                  await waitForUpdate(streamId, longPollTimeoutMs, signal);
                }
              } catch (err) {
                emit("error", { message: err instanceof Error ? err.message : "tail failed" });
              } finally {
                controller.close();
              }
            },
          });

          return new Response(body, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          });
        } catch (err) {
          return errorResponse(err);
        }
      });

      // ── POST /:id/close ───────────────────────────────────────────────────

      ctx.app.post(`${mountPath}/:id/close`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        try {
          await assertPrincipalInOrg(principal);
          const streamId = c.req.param("id");
          const row = await loadStream(streamId);
          if (!row) return c.json({ error: "stream not found", code: "NOT_FOUND" }, 404);
          await assertWriteAccess(row, principal);
          closeBody.parse(await c.req.json().catch(() => ({})));

          if (row.status !== "open") {
            return c.json({ durableStreamId: streamId, status: row.status, chunkCount: row.chunk_count });
          }

          // Write manifest so the full stream can be restored from storage alone
          const manifest = {
            streamId,
            orgId: principal.orgId,
            actorId: principal.actorId,
            contentType: row.content_type,
            chunkCount: row.chunk_count,
            byteCount: row.byte_count,
            targetStreamId: row.target_stream_id,
            targetStreamType: row.target_stream_type,
            metadata: safeJson(row.metadata_json),
            closedAt: new Date().toISOString(),
          };
          await storage.put(
            manifestKey(principal.orgId, streamId),
            Buffer.from(JSON.stringify(manifest), "utf8"),
            { contentType: "application/json" },
          );

          const now = new Date().toISOString();
          await ctx.db.query(
            "UPDATE dss_streams SET status='closed', updated_at=?, closed_at=? WHERE id=?",
            [now, now, streamId],
          );
          notify(streamId);
          return c.json({ durableStreamId: streamId, status: "closed", chunkCount: row.chunk_count });
        } catch (err) {
          return errorResponse(err);
        }
      });

      // ── POST /:id/commit ──────────────────────────────────────────────────

      ctx.app.post(`${mountPath}/:id/commit`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) return c.json({ error: "missing or invalid principal", code: "UNAUTHORIZED" }, 401);
        try {
          await assertPrincipalInOrg(principal);
          const streamId = c.req.param("id");
          const row = await loadStream(streamId);
          if (!row) return c.json({ error: "stream not found", code: "NOT_FOUND" }, 404);
          await assertWriteAccess(row, principal);

          if (!row.target_stream_id || !row.target_stream_type) {
            throw new ValidationError("stream has no target stream for commit");
          }
          const body = commitBody.parse(await c.req.json().catch(() => ({})));

          // Idempotent: already committed
          if (row.committed_message_id) {
            return c.json({ durableStreamId: streamId, status: row.status, committedMessageId: row.committed_message_id });
          }

          // Read all chunks from storage and assemble
          const parts: string[] = [];
          for (let i = 1; i <= Number(row.chunk_count); i++) {
            const obj = await storage.get(chunkKey(principal.orgId, streamId, i));
            if (obj) parts.push(obj.content.toString("utf8"));
          }
          const fullText = parts.join("");

          const appendResult = await ctx.service.appendMessage(principal, {
            streamId: row.target_stream_id,
            streamType: row.target_stream_type,
            parts: [{ type: "text", payload: { text: fullText } }],
            idempotencyKey:
              body.idempotencyKey ?? `dss-commit-${streamId}-${principal.actorId}`,
          });

          if ("denied" in appendResult && appendResult.denied) {
            return c.json(
              { denied: true, requestId: appendResult.requestId, capability: appendResult.capability },
              403,
            );
          }

          const now = new Date().toISOString();
          await ctx.db.query(
            "UPDATE dss_streams SET status='committed', committed_message_id=?, updated_at=?, closed_at=? WHERE id=?",
            [appendResult.messageId, now, now, streamId],
          );
          notify(streamId);

          return c.json({
            durableStreamId: streamId,
            status: "committed",
            committedMessageId: appendResult.messageId,
            streamSeq: appendResult.streamSeq,
            chunkCount: row.chunk_count,
            byteCount: row.byte_count,
          });
        } catch (err) {
          return errorResponse(err);
        }
      });
    },
  };
}
