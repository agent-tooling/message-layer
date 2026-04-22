import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";

// The storage layer is intentionally small: one interface, two adapters.
// - `pglite` for local-first development
// - `postgres` for hosted deployments and Neon-backed tests
//
// Both adapters share the same schema and transaction semantics so service
// code stays storage-agnostic.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('human', 'agent', 'app')),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id)
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  channel_id TEXT,
  role TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (org_id, actor_id, channel_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  parent_message_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stream_counters (
  stream_id TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_type TEXT NOT NULL CHECK (stream_type IN ('channel', 'thread')),
  actor_id TEXT NOT NULL,
  stream_seq INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  redacted INTEGER NOT NULL DEFAULT 0,
  redacted_at TEXT,
  redacted_by_actor_id TEXT,
  redaction_reason TEXT,
  UNIQUE (org_id, stream_id, actor_id, idempotency_key),
  UNIQUE (stream_id, stream_seq)
);

CREATE TABLE IF NOT EXISTS message_parts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  part_index INTEGER NOT NULL,
  part_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (message_id, part_index)
);

CREATE TABLE IF NOT EXISTS cursors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL,
  last_ack_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, actor_id, stream_id)
);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  capability TEXT NOT NULL,
  expires_at TEXT,
  constraints_json TEXT NOT NULL DEFAULT '{}',
  max_uses INTEGER,
  uses_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_actor_id TEXT,
  revocation_reason TEXT
);

CREATE TABLE IF NOT EXISTS permission_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'denied')),
  request_context_json TEXT NOT NULL DEFAULT '{}',
  resolution_notes TEXT,
  resolver_actor_id TEXT,
  grant_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_type TEXT NOT NULL CHECK (stream_type IN ('channel', 'thread')),
  storage_kind TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  deleted_by_actor_id TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  stream_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  stream_seq INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash TEXT,
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS registered_commands (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  channel_id            TEXT,
  name                  TEXT NOT NULL,
  owner_actor_id        TEXT NOT NULL,
  description           TEXT,
  args_schema_json      TEXT NOT NULL DEFAULT '{}',
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  permission_request_id TEXT,
  created_at            TEXT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id),
  FOREIGN KEY (owner_actor_id) REFERENCES actors(id),
  UNIQUE (org_id, channel_id, owner_actor_id, name)
);

CREATE INDEX IF NOT EXISTS idx_messages_stream ON messages(stream_id, stream_seq);
CREATE INDEX IF NOT EXISTS idx_events_stream ON events(stream_id, stream_seq);
CREATE INDEX IF NOT EXISTS idx_events_org ON events(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_events(org_id, audit_seq);
CREATE INDEX IF NOT EXISTS idx_memberships_actor ON memberships(org_id, actor_id);
CREATE INDEX IF NOT EXISTS idx_memberships_channel ON memberships(org_id, channel_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_stream ON artifacts(org_id, stream_id);
CREATE INDEX IF NOT EXISTS idx_grants_lookup ON grants(org_id, actor_id, capability, resource_type, active);
CREATE INDEX IF NOT EXISTS idx_commands_lookup ON registered_commands(org_id, channel_id, name, status);
`;

export type SqlValue = string | number | null;
export type SqlAdapter = "pglite" | "postgres";

export interface QueryResultRow {
  [key: string]: unknown;
}

export interface DbClient {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: SqlValue[],
  ): Promise<{ rows: T[] }>;
}

export interface SqlDatabase extends DbClient {
  readonly adapter: SqlAdapter;
  tx<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  close?(): Promise<void> | void;
}

function rewritePositionalParams(sql: string): string {
  let i = 0;
  return sql.replaceAll("?", () => {
    i += 1;
    return `$${i}`;
  });
}

class PgliteClient implements SqlDatabase {
  readonly adapter: SqlAdapter = "pglite";

  constructor(private readonly db: PGlite) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: SqlValue[] = [],
  ): Promise<{ rows: T[] }> {
    const result = await this.db.query<T>(rewritePositionalParams(sql), params);
    return { rows: result.rows ?? [] };
  }

  async tx<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    await this.db.exec("BEGIN");
    try {
      const txClient: DbClient = {
        query: async <R extends QueryResultRow = QueryResultRow>(
          sql: string,
          params: SqlValue[] = [],
        ) => {
          const result = await this.db.query<R>(
            rewritePositionalParams(sql),
            params,
          );
          return { rows: result.rows ?? [] };
        },
      };
      const output = await fn(txClient);
      await this.db.exec("COMMIT");
      return output;
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

class PostgresClient implements SqlDatabase {
  readonly adapter: SqlAdapter = "postgres";

  constructor(private readonly pool: Pool) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: SqlValue[] = [],
  ): Promise<{ rows: T[] }> {
    const result = await this.pool.query<T>(
      rewritePositionalParams(sql),
      params,
    );
    return { rows: result.rows ?? [] };
  }

  async tx<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const txClient: DbClient = {
        query: async <R extends QueryResultRow = QueryResultRow>(
          sql: string,
          params: SqlValue[] = [],
        ) => {
          const result = await client.query<R>(
            rewritePositionalParams(sql),
            params,
          );
          return { rows: result.rows ?? [] };
        },
      };
      const output = await fn(txClient);
      await client.query("COMMIT");
      return output;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function createPgliteDatabase(
  path = "memory://",
): Promise<SqlDatabase> {
  const db = new PGlite(path);
  await db.exec(SCHEMA_SQL);
  return new PgliteClient(db);
}

export async function createPostgresDatabase(
  connectionString: string,
): Promise<SqlDatabase> {
  if (!connectionString || connectionString.trim().length === 0) {
    throw new Error("postgres adapter requires a non-empty connection string");
  }
  const pool = new Pool({
    connectionString,
    // Neon pooler requires TLS. `pg` accepts this shape in Node and will
    // ignore it for local plain-text Postgres URLs.
    ssl: { rejectUnauthorized: false },
  });
  await pool.query(SCHEMA_SQL);
  return new PostgresClient(pool);
}

export async function connect(
  path = "memory://",
  adapter: SqlAdapter = "pglite",
): Promise<SqlDatabase> {
  if (adapter === "pglite") {
    return createPgliteDatabase(path);
  }
  if (adapter === "postgres") {
    return createPostgresDatabase(path);
  }
  throw new Error(`unsupported storage adapter: ${adapter as string}`);
}
