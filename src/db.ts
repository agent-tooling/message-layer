import { PGlite } from "@electric-sql/pglite";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('human', 'agent', 'app')),
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id)
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  channel_id TEXT,
  role TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_by_actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  parent_message_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_by_actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
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
  created_at TIMESTAMPTZ NOT NULL,
  redacted BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (org_id, stream_id, actor_id, idempotency_key),
  UNIQUE (stream_id, stream_seq)
);

CREATE TABLE IF NOT EXISTS message_parts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  part_index INTEGER NOT NULL,
  part_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  UNIQUE (message_id, part_index)
);

CREATE TABLE IF NOT EXISTS cursors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL,
  last_ack_seq INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (org_id, actor_id, stream_id)
);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  capability TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  constraints_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS permission_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'denied')),
  resolution_notes TEXT,
  resolver_actor_id TEXT,
  grant_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  stream_id TEXT,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  stream_seq INTEGER,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_seq BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  prev_hash TEXT,
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export type SqlValue = string | number | boolean | null;

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
  tx<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
}

function toSql(sql: string): string {
  return sql.replaceAll("?", "$1");
}

function rewritePositionalParams(sql: string): string {
  let i = 0;
  return sql.replaceAll("?", () => {
    i += 1;
    return `$${i}`;
  });
}

class PgliteClient implements SqlDatabase {
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
          const result = await this.db.query<R>(rewritePositionalParams(sql), params);
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
}

export async function createPgliteDatabase(path = "memory://"): Promise<SqlDatabase> {
  const db = new PGlite(path);
  await db.exec(SCHEMA_SQL);
  return new PgliteClient(db);
}

// Backward-compatible alias used by tests and sample flows.
export const connect = createPgliteDatabase;
