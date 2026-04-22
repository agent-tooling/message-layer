import { randomUUID } from "node:crypto";
import { z } from "zod";
import { deriveStorageKey } from "../storage.js";
import {
  PermissionError,
  ValidationError,
  principalSchema,
  streamTypeSchema,
  type Principal,
  type StreamType,
} from "../types.js";
import type { ServerPlugin } from "../plugins.js";

type DurableStreamRow = {
  id: string;
  org_id: string;
  actor_id: string;
  target_stream_id: string | null;
  target_stream_type: StreamType | null;
  content_type: string;
  latest_offset: number;
  status: "open" | "closed" | "committed";
  metadata_json: string;
  backup_key: string | null;
  committed_message_id: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

type DurableChunkRow = {
  stream_id: string;
  chunk_offset: number;
  chunk_text: string;
  created_at: string;
};

const createStreamBody = z.object({
  targetStreamId: z.string().min(1).optional(),
  targetStreamType: streamTypeSchema.optional(),
  contentType: z.string().min(1).max(120).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const appendChunksBody = z.object({
  chunks: z.array(z.object({ text: z.string() })).min(1),
});

const closeBody = z.object({
  reason: z.string().max(500).optional(),
});

const commitBody = z.object({
  idempotencyKey: z.string().min(1).max(120).optional(),
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

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function assertPrincipalInOrg(
  principal: Principal,
  query: (sql: string, params?: Array<string | number | null>) => Promise<{ rows: Array<{ ok: number }> }>,
): Promise<void> {
  const row = await query("SELECT 1 AS ok FROM actors WHERE id=? AND org_id=? LIMIT 1", [
    principal.actorId,
    principal.orgId,
  ]);
  if (!row.rows[0]) {
    throw new PermissionError("actor is not in org");
  }
}

async function hasCapability(
  principal: Principal,
  capability: "durable_stream:read" | "durable_stream:write",
  serviceHasGrant: (orgId: string, actorId: string, capability: string) => Promise<boolean>,
): Promise<boolean> {
  if (principal.scopes.includes(capability)) return true;
  return serviceHasGrant(principal.orgId, principal.actorId, capability);
}

function errorResponse(error: unknown): Response {
  if (error instanceof PermissionError) {
    return new Response(
      JSON.stringify({ error: error.message, code: "PERMISSION_DENIED" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  if (error instanceof ValidationError || error instanceof z.ZodError) {
    return new Response(
      JSON.stringify({ error: "invalid request", code: "VALIDATION" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
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

async function loadStream(
  query: (sql: string, params?: Array<string | number | null>) => Promise<{ rows: DurableStreamRow[] }>,
  streamId: string,
): Promise<DurableStreamRow | null> {
  const rows = await query(
    `SELECT id,org_id,actor_id,target_stream_id,target_stream_type,content_type,latest_offset,status,metadata_json,backup_key,committed_message_id,created_at,updated_at,closed_at
       FROM durable_streams
      WHERE id=?
      LIMIT 1`,
    [streamId],
  );
  return rows.rows[0] ?? null;
}

function streamVisibleToPrincipal(row: DurableStreamRow, principal: Principal): boolean {
  return row.actor_id === principal.actorId;
}

export function durableStreamsPlugin(options?: Record<string, unknown>): ServerPlugin {
  const mountPath =
    typeof options?.mountPath === "string"
      ? options.mountPath
      : "/v1/durable-streams";
  const longPollTimeoutMs = Number(options?.longPollTimeoutMs ?? 30_000);
  const waiters = new Map<string, Set<() => void>>();

  function notify(streamId: string): void {
    const set = waiters.get(streamId);
    if (!set) return;
    for (const resolve of set) resolve();
    waiters.delete(streamId);
  }

  function waitForUpdate(
    streamId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
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
        clearTimeout(timeout);
        const current = waiters.get(streamId);
        current?.delete(onWake);
        if (current && current.size === 0) waiters.delete(streamId);
        signal?.removeEventListener("abort", abortListener);
      }
    });
  }

  async function assertReadAccess(
    principal: Principal,
    streamRow: DurableStreamRow,
    serviceHasGrant: (orgId: string, actorId: string, capability: string) => Promise<boolean>,
    assertCanReadStream: (principal: Principal, streamId: string) => Promise<void>,
  ): Promise<void> {
    if (streamRow.org_id !== principal.orgId) {
      throw new PermissionError("durable stream not found");
    }
    if (streamVisibleToPrincipal(streamRow, principal)) return;
    if (streamRow.target_stream_id) {
      // Linked streams inherit the target stream's privacy boundary. A broad
      // durable_stream:read capability must never bypass private-stream access.
      await assertCanReadStream(principal, streamRow.target_stream_id);
      return;
    }
    if (await hasCapability(principal, "durable_stream:read", serviceHasGrant)) return;
    throw new PermissionError("missing durable_stream:read");
  }

  async function assertWriteAccess(
    principal: Principal,
    streamRow: DurableStreamRow,
    serviceHasGrant: (orgId: string, actorId: string, capability: string) => Promise<boolean>,
  ): Promise<void> {
    if (streamRow.org_id !== principal.orgId) {
      throw new PermissionError("durable stream not found");
    }
    if (streamVisibleToPrincipal(streamRow, principal)) return;
    if (await hasCapability(principal, "durable_stream:write", serviceHasGrant)) return;
    throw new PermissionError("missing durable_stream:write");
  }

  async function backupStream(streamRow: DurableStreamRow, query: (sql: string, params?: Array<string | number | null>) => Promise<{ rows: DurableChunkRow[] }>, put: (key: string, content: Buffer, opts: { contentType: string }) => Promise<void>): Promise<string> {
    const chunksRes = await query(
      "SELECT stream_id,chunk_offset,chunk_text,created_at FROM durable_stream_chunks WHERE stream_id=? ORDER BY chunk_offset ASC",
      [streamRow.id],
    );
    const backupPayload = {
      stream: {
        id: streamRow.id,
        orgId: streamRow.org_id,
        actorId: streamRow.actor_id,
        status: streamRow.status,
        targetStreamId: streamRow.target_stream_id,
        targetStreamType: streamRow.target_stream_type,
        contentType: streamRow.content_type,
        latestOffset: streamRow.latest_offset,
        metadata: safeJson(streamRow.metadata_json),
        createdAt: streamRow.created_at,
        updatedAt: streamRow.updated_at,
      },
      chunks: chunksRes.rows.map((row) => ({
        offset: row.chunk_offset,
        text: row.chunk_text,
        createdAt: row.created_at,
      })),
    };
    const key = deriveStorageKey(streamRow.org_id, `durable-stream-${streamRow.id}`);
    await put(key, Buffer.from(JSON.stringify(backupPayload), "utf8"), {
      contentType: "application/json",
    });
    return key;
  }

  return {
    name: "durable-streams",
    schemaSql: {
      name: "durable-streams",
      sql: [
        `CREATE TABLE IF NOT EXISTS durable_streams (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          target_stream_id TEXT,
          target_stream_type TEXT,
          content_type TEXT NOT NULL,
          latest_offset INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'open',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          backup_key TEXT,
          committed_message_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          closed_at TEXT,
          FOREIGN KEY (org_id) REFERENCES organizations(id),
          FOREIGN KEY (actor_id) REFERENCES actors(id)
        )`,
        "CREATE INDEX IF NOT EXISTS idx_durable_streams_org_actor ON durable_streams(org_id, actor_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_durable_streams_org_target ON durable_streams(org_id, target_stream_id)",
        `CREATE TABLE IF NOT EXISTS durable_stream_chunks (
          id TEXT PRIMARY KEY,
          stream_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          chunk_offset INTEGER NOT NULL,
          chunk_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (stream_id) REFERENCES durable_streams(id),
          UNIQUE(stream_id, chunk_offset)
        )`,
        "CREATE INDEX IF NOT EXISTS idx_durable_stream_chunks_stream_offset ON durable_stream_chunks(stream_id, chunk_offset)",
      ],
    },
    registerRoutes(ctx) {
      ctx.app.post(`${mountPath}`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json(
            { error: "missing or invalid principal", code: "UNAUTHORIZED" },
            401,
          );
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const body = createStreamBody.parse(await c.req.json().catch(() => ({})));
          if ((body.targetStreamId && !body.targetStreamType) || (!body.targetStreamId && body.targetStreamType)) {
            throw new ValidationError(
              "targetStreamId and targetStreamType must be provided together",
            );
          }
          if (body.targetStreamId && body.targetStreamType) {
            await ctx.service.assertCanReadStream(principal, body.targetStreamId);
          }

          const streamId = randomUUID().replaceAll("-", "");
          const now = new Date().toISOString();
          await ctx.db.query(
            `INSERT INTO durable_streams(id,org_id,actor_id,target_stream_id,target_stream_type,content_type,latest_offset,status,metadata_json,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [
              streamId,
              principal.orgId,
              principal.actorId,
              body.targetStreamId ?? null,
              body.targetStreamType ?? null,
              body.contentType ?? "text/plain; charset=utf-8",
              0,
              "open",
              JSON.stringify(body.metadata ?? {}),
              now,
              now,
            ],
          );
          return c.json({
            durableStreamId: streamId,
            status: "open",
            offset: 0,
          });
        } catch (error) {
          return errorResponse(error);
        }
      });

      ctx.app.get(`${mountPath}/:streamId/head`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json(
            { error: "missing or invalid principal", code: "UNAUTHORIZED" },
            401,
          );
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const row = await loadStream(ctx.db.query.bind(ctx.db), c.req.param("streamId"));
          if (!row) return c.json({ error: "stream not found", code: "NOT_FOUND" }, 404);
          await assertReadAccess(
            principal,
            row,
            ctx.service.checkGrant.bind(ctx.service),
            ctx.service.assertCanReadStream.bind(ctx.service),
          );
          return c.json({
            durableStreamId: row.id,
            status: row.status,
            offset: row.latest_offset,
            targetStreamId: row.target_stream_id,
            targetStreamType: row.target_stream_type,
            backupKey: row.backup_key,
            committedMessageId: row.committed_message_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            closedAt: row.closed_at,
          });
        } catch (error) {
          return errorResponse(error);
        }
      });

      ctx.app.post(`${mountPath}/:streamId/chunks`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json(
            { error: "missing or invalid principal", code: "UNAUTHORIZED" },
            401,
          );
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const streamId = c.req.param("streamId");
          const row = await loadStream(ctx.db.query.bind(ctx.db), streamId);
          if (!row) return c.json({ error: "stream not found", code: "NOT_FOUND" }, 404);
          await assertWriteAccess(
            principal,
            row,
            ctx.service.checkGrant.bind(ctx.service),
          );
          if (row.status !== "open") {
            throw new ValidationError("stream is closed");
          }
          const body = appendChunksBody.parse(await c.req.json());
          let nextOffset = Number(row.latest_offset ?? 0);
          const now = new Date().toISOString();
          for (const chunk of body.chunks) {
            nextOffset += 1;
            await ctx.db.query(
              `INSERT INTO durable_stream_chunks(id,stream_id,org_id,chunk_offset,chunk_text,created_at)
               VALUES (?,?,?,?,?,?)`,
              [
                randomUUID().replaceAll("-", ""),
                streamId,
                principal.orgId,
                nextOffset,
                chunk.text,
                now,
              ],
            );
          }
          await ctx.db.query(
            "UPDATE durable_streams SET latest_offset=?, updated_at=? WHERE id=?",
            [nextOffset, now, streamId],
          );
          notify(streamId);
          return c.json({
            durableStreamId: streamId,
            appended: body.chunks.length,
            offset: nextOffset,
          });
        } catch (error) {
          return errorResponse(error);
        }
      });

      ctx.app.get(`${mountPath}/:streamId/read`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json(
            { error: "missing or invalid principal", code: "UNAUTHORIZED" },
            401,
          );
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const streamId = c.req.param("streamId");
          const row = await loadStream(ctx.db.query.bind(ctx.db), streamId);
          if (!row) return c.json({ error: "stream not found", code: "NOT_FOUND" }, 404);
          await assertReadAccess(
            principal,
            row,
            ctx.service.checkGrant.bind(ctx.service),
            ctx.service.assertCanReadStream.bind(ctx.service),
          );

          const offsetRaw = Number(c.req.query("offset") ?? "0");
          const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
          const limitRaw = Number(c.req.query("limit") ?? "200");
          const limit = Number.isFinite(limitRaw)
            ? Math.max(1, Math.min(2000, Math.floor(limitRaw)))
            : 200;
          const live = c.req.query("live") === "true";
          const timeoutRaw = Number(c.req.query("timeoutMs") ?? longPollTimeoutMs);
          const timeoutMs = Number.isFinite(timeoutRaw)
            ? Math.max(50, Math.min(120_000, Math.floor(timeoutRaw)))
            : longPollTimeoutMs;

          async function readChunkBatch() {
            const chunks = await ctx.db.query<DurableChunkRow>(
              `SELECT stream_id,chunk_offset,chunk_text,created_at
                 FROM durable_stream_chunks
                WHERE stream_id=? AND chunk_offset>?
                ORDER BY chunk_offset ASC
                LIMIT ?`,
              [streamId, offset, limit],
            );
            return chunks.rows;
          }

          let chunks = await readChunkBatch();
          if (chunks.length === 0 && live && row.status === "open") {
            await waitForUpdate(streamId, timeoutMs, c.req.raw.signal);
            chunks = await readChunkBatch();
          }
          const nextOffset = chunks.length > 0 ? chunks[chunks.length - 1]!.chunk_offset : offset;
          const reloaded = await loadStream(ctx.db.query.bind(ctx.db), streamId);
          const latestOffset = Number(reloaded?.latest_offset ?? row.latest_offset ?? 0);
          const upToDate = nextOffset >= latestOffset;
          return c.json({
            durableStreamId: streamId,
            status: reloaded?.status ?? row.status,
            fromOffset: offset,
            nextOffset,
            upToDate,
            chunks: chunks.map((chunk) => ({
              offset: chunk.chunk_offset,
              text: chunk.chunk_text,
              createdAt: chunk.created_at,
            })),
          });
        } catch (error) {
          return errorResponse(error);
        }
      });

      ctx.app.get(`${mountPath}/:streamId/tail`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json(
            { error: "missing or invalid principal", code: "UNAUTHORIZED" },
            401,
          );
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const streamId = c.req.param("streamId");
          const row = await loadStream(ctx.db.query.bind(ctx.db), streamId);
          if (!row) return c.json({ error: "stream not found", code: "NOT_FOUND" }, 404);
          await assertReadAccess(
            principal,
            row,
            ctx.service.checkGrant.bind(ctx.service),
            ctx.service.assertCanReadStream.bind(ctx.service),
          );
          const offsetRaw = Number(c.req.query("offset") ?? "0");
          const startOffset = Number.isFinite(offsetRaw)
            ? Math.max(0, Math.floor(offsetRaw))
            : 0;
          const encoder = new TextEncoder();

          const body = new ReadableStream<Uint8Array>({
            start: async (controller) => {
              let offset = startOffset;
              const signal = c.req.raw.signal;
              const writeEvent = (event: string, payload: Record<string, unknown>) => {
                controller.enqueue(
                  encoder.encode(
                    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
                  ),
                );
              };

              try {
                writeEvent("ready", { durableStreamId: streamId, offset });
                while (!signal.aborted) {
                  const chunks = await ctx.db.query<DurableChunkRow>(
                    `SELECT stream_id,chunk_offset,chunk_text,created_at
                       FROM durable_stream_chunks
                      WHERE stream_id=? AND chunk_offset>?
                      ORDER BY chunk_offset ASC
                      LIMIT 200`,
                    [streamId, offset],
                  );
                  if (chunks.rows.length > 0) {
                    offset = chunks.rows[chunks.rows.length - 1]!.chunk_offset;
                    writeEvent("chunks", {
                      offset,
                      items: chunks.rows.map((chunk) => ({
                        offset: chunk.chunk_offset,
                        text: chunk.chunk_text,
                        createdAt: chunk.created_at,
                      })),
                    });
                    continue;
                  }

                  const current = await loadStream(ctx.db.query.bind(ctx.db), streamId);
                  if (!current || current.status !== "open") {
                    writeEvent("eof", { durableStreamId: streamId, offset });
                    break;
                  }
                  await waitForUpdate(streamId, longPollTimeoutMs, signal);
                }
              } catch (error) {
                writeEvent("error", {
                  message:
                    error instanceof Error ? error.message : "tail stream failed",
                });
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
        } catch (error) {
          return errorResponse(error);
        }
      });

      ctx.app.post(`${mountPath}/:streamId/close`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json(
            { error: "missing or invalid principal", code: "UNAUTHORIZED" },
            401,
          );
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const streamId = c.req.param("streamId");
          const row = await loadStream(ctx.db.query.bind(ctx.db), streamId);
          if (!row) return c.json({ error: "stream not found", code: "NOT_FOUND" }, 404);
          await assertWriteAccess(
            principal,
            row,
            ctx.service.checkGrant.bind(ctx.service),
          );
          closeBody.parse(await c.req.json().catch(() => ({})));
          if (row.status === "closed" || row.status === "committed") {
            return c.json({
              durableStreamId: streamId,
              status: row.status,
              backupKey: row.backup_key,
              offset: row.latest_offset,
            });
          }
          const backupKey = await backupStream(
            row,
            ctx.db.query.bind(ctx.db),
            ctx.service.storage.put.bind(ctx.service.storage),
          );
          const now = new Date().toISOString();
          await ctx.db.query(
            "UPDATE durable_streams SET status='closed', backup_key=?, updated_at=?, closed_at=? WHERE id=?",
            [backupKey, now, now, streamId],
          );
          notify(streamId);
          return c.json({
            durableStreamId: streamId,
            status: "closed",
            backupKey,
            offset: row.latest_offset,
          });
        } catch (error) {
          return errorResponse(error);
        }
      });

      ctx.app.post(`${mountPath}/:streamId/commit`, async (c) => {
        const principal = parsePrincipal(c.req.header("x-principal"));
        if (!principal) {
          return c.json(
            { error: "missing or invalid principal", code: "UNAUTHORIZED" },
            401,
          );
        }
        try {
          await assertPrincipalInOrg(principal, ctx.db.query.bind(ctx.db));
          const streamId = c.req.param("streamId");
          const row = await loadStream(ctx.db.query.bind(ctx.db), streamId);
          if (!row) return c.json({ error: "stream not found", code: "NOT_FOUND" }, 404);
          await assertWriteAccess(
            principal,
            row,
            ctx.service.checkGrant.bind(ctx.service),
          );
          if (!row.target_stream_id || !row.target_stream_type) {
            throw new ValidationError(
              "stream has no target stream for commit",
            );
          }

          const body = commitBody.parse(await c.req.json().catch(() => ({})));
          if (row.committed_message_id) {
            return c.json({
              durableStreamId: streamId,
              status: row.status,
              committedMessageId: row.committed_message_id,
            });
          }

          const chunks = await ctx.db.query<DurableChunkRow>(
            "SELECT stream_id,chunk_offset,chunk_text,created_at FROM durable_stream_chunks WHERE stream_id=? ORDER BY chunk_offset ASC",
            [streamId],
          );
          const text = chunks.rows.map((chunk) => chunk.chunk_text).join("");
          const append = await ctx.service.appendMessage(principal, {
            streamId: row.target_stream_id,
            streamType: row.target_stream_type,
            parts: [{ type: "text", payload: { text } }],
            idempotencyKey:
              body.idempotencyKey ??
              `durable-stream-commit-${streamId}-${principal.actorId}`,
          });
          if ("denied" in append && append.denied) {
            return c.json(
              {
                denied: true,
                requestId: append.requestId,
                capability: append.capability,
              },
              403,
            );
          }
          const now = new Date().toISOString();
          const currentForBackup = (await loadStream(
            ctx.db.query.bind(ctx.db),
            streamId,
          )) ?? row;
          const backupKey =
            currentForBackup.backup_key ??
            (await backupStream(
              currentForBackup,
              ctx.db.query.bind(ctx.db),
              ctx.service.storage.put.bind(ctx.service.storage),
            ));
          await ctx.db.query(
            "UPDATE durable_streams SET status='committed', committed_message_id=?, backup_key=?, updated_at=?, closed_at=? WHERE id=?",
            [append.messageId, backupKey, now, now, streamId],
          );
          notify(streamId);
          return c.json({
            durableStreamId: streamId,
            status: "committed",
            committedMessageId: append.messageId,
            backupKey,
            streamSeq: append.streamSeq,
          });
        } catch (error) {
          return errorResponse(error);
        }
      });
    },
  };
}
