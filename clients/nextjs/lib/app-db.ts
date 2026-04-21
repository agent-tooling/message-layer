import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import Database from "better-sqlite3";

// `TEAM_CLIENT_DATA_DIR` lets tests and isolated dev instances point at a
// dedicated data directory instead of sharing the default `.data/` folder
// next to `package.json`. Relative paths resolve against `process.cwd()`.
const dataDirEnv = process.env.TEAM_CLIENT_DATA_DIR;
const dataDir = dataDirEnv
  ? isAbsolute(dataDirEnv)
    ? dataDirEnv
    : join(process.cwd(), dataDirEnv)
  : join(process.cwd(), ".data");
mkdirSync(dataDir, { recursive: true });

const dbPath = join(dataDir, "team-client.db");
const sqlite = new Database(dbPath);

export const TEAM_CLIENT_DATA_DIR = dataDir;

sqlite.exec(`
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_actor_map (
  user_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  inviter_user_id TEXT NOT NULL,
  consumed_by_user_id TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_type TEXT NOT NULL,
  uploader_actor_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  disk_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_join_requests (
  id TEXT PRIMARY KEY,
  request_secret TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'denied')),
  actor_id TEXT,
  note TEXT,
  resolved_by_user_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
`);

export type UserActorRow = {
  user_id: string;
  actor_id: string;
  org_id: string;
  display_name: string;
  created_at: string;
};

export type UserRole = "owner" | "admin" | "member";

export type AttachmentRow = {
  id: string;
  org_id: string;
  stream_id: string;
  stream_type: string;
  uploader_actor_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  disk_path: string;
  created_at: string;
};

export type AgentJoinRequestStatus = "open" | "approved" | "denied";
export type AgentJoinRequestRow = {
  id: string;
  request_secret: string;
  org_id: string;
  display_name: string;
  status: AgentJoinRequestStatus;
  actor_id: string | null;
  note: string | null;
  resolved_by_user_id: string | null;
  created_at: string;
  resolved_at: string | null;
};

export function getSetting(key: string): string | null {
  const row = sqlite.prepare("SELECT value FROM app_settings WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  sqlite.prepare(
    `INSERT INTO app_settings(key,value) VALUES (?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(key, value);
}

export function getUserActorMap(userId: string): UserActorRow | null {
  const row = sqlite.prepare("SELECT user_id,actor_id,org_id,display_name,created_at FROM user_actor_map WHERE user_id=?").get(userId);
  return (row as UserActorRow | undefined) ?? null;
}

export function setUserActorMap(input: UserActorRow): void {
  sqlite.prepare(
    `INSERT INTO user_actor_map(user_id,actor_id,org_id,display_name,created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET actor_id=excluded.actor_id,org_id=excluded.org_id,display_name=excluded.display_name`,
  ).run(input.user_id, input.actor_id, input.org_id, input.display_name, input.created_at);
}

export function getUserIdByActorId(actorId: string): string | null {
  const row = sqlite
    .prepare("SELECT user_id FROM user_actor_map WHERE actor_id=?")
    .get(actorId) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

export function getUserRole(userId: string): UserRole | null {
  const row = sqlite
    .prepare("SELECT role FROM user_roles WHERE user_id=?")
    .get(userId) as { role: string } | undefined;
  if (!row) return null;
  if (row.role === "owner" || row.role === "admin" || row.role === "member") {
    return row.role;
  }
  return null;
}

export function setUserRole(userId: string, role: UserRole): void {
  sqlite
    .prepare(
      `INSERT INTO user_roles(user_id,role,updated_at)
       VALUES (?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at`,
    )
    .run(userId, role, new Date().toISOString());
}

export function createInvite(input: { token: string; email: string; role: string; inviterUserId: string; createdAt: string }): void {
  sqlite
    .prepare(
      "INSERT INTO invites(token,email,role,inviter_user_id,created_at) VALUES (?,?,?,?,?)",
    )
    .run(input.token, input.email, input.role, input.inviterUserId, input.createdAt);
}

export function consumeInvite(token: string, userId: string): { token: string; email: string; role: string } | null {
  const row = sqlite.prepare("SELECT token,email,role,consumed_by_user_id FROM invites WHERE token=?").get(token) as
    | { token: string; email: string; role: string; consumed_by_user_id: string | null }
    | undefined;
  if (!row || row.consumed_by_user_id) {
    return null;
  }
  sqlite
    .prepare("UPDATE invites SET consumed_by_user_id=?,consumed_at=? WHERE token=?")
    .run(userId, new Date().toISOString(), token);
  return { token: row.token, email: row.email, role: row.role };
}

export function insertAttachment(row: AttachmentRow): void {
  sqlite
    .prepare(
      `INSERT INTO attachments(id,org_id,stream_id,stream_type,uploader_actor_id,filename,mime_type,size_bytes,disk_path,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.id,
      row.org_id,
      row.stream_id,
      row.stream_type,
      row.uploader_actor_id,
      row.filename,
      row.mime_type,
      row.size_bytes,
      row.disk_path,
      row.created_at,
    );
}

export function getAttachment(id: string): AttachmentRow | null {
  const row = sqlite
    .prepare(
      `SELECT id,org_id,stream_id,stream_type,uploader_actor_id,filename,mime_type,size_bytes,disk_path,created_at
       FROM attachments
       WHERE id=?`,
    )
    .get(id);
  return (row as AttachmentRow | undefined) ?? null;
}

export function listInvites(): Array<{ token: string; email: string; role: string; consumedAt: string | null; createdAt: string }> {
  const rows = sqlite
    .prepare("SELECT token,email,role,consumed_at AS consumedAt,created_at AS createdAt FROM invites ORDER BY created_at DESC")
    .all();
  return rows as Array<{ token: string; email: string; role: string; consumedAt: string | null; createdAt: string }>;
}

export function hasConsumedInvite(userId: string): boolean {
  const row = sqlite
    .prepare("SELECT 1 FROM invites WHERE consumed_by_user_id=? LIMIT 1")
    .get(userId) as { 1: number } | undefined;
  return Boolean(row);
}

export function createAgentJoinRequest(input: {
  id: string;
  requestSecret: string;
  orgId: string;
  displayName: string;
  createdAt: string;
}): void {
  sqlite
    .prepare(
      `INSERT INTO agent_join_requests(
         id,request_secret,org_id,display_name,status,created_at
       ) VALUES (?,?,?,?, 'open', ?)`,
    )
    .run(input.id, input.requestSecret, input.orgId, input.displayName, input.createdAt);
}

export function getAgentJoinRequestBySecret(
  id: string,
  requestSecret: string,
): AgentJoinRequestRow | null {
  const row = sqlite
    .prepare(
      `SELECT id,request_secret,org_id,display_name,status,actor_id,note,resolved_by_user_id,created_at,resolved_at
       FROM agent_join_requests
       WHERE id=? AND request_secret=?`,
    )
    .get(id, requestSecret);
  return (row as AgentJoinRequestRow | undefined) ?? null;
}

export function getAgentJoinRequestById(id: string): AgentJoinRequestRow | null {
  const row = sqlite
    .prepare(
      `SELECT id,request_secret,org_id,display_name,status,actor_id,note,resolved_by_user_id,created_at,resolved_at
       FROM agent_join_requests
       WHERE id=?`,
    )
    .get(id);
  return (row as AgentJoinRequestRow | undefined) ?? null;
}

export function listOpenAgentJoinRequests(orgId: string): AgentJoinRequestRow[] {
  const rows = sqlite
    .prepare(
      `SELECT id,request_secret,org_id,display_name,status,actor_id,note,resolved_by_user_id,created_at,resolved_at
       FROM agent_join_requests
       WHERE org_id=? AND status='open'
       ORDER BY created_at ASC`,
    )
    .all(orgId);
  return rows as AgentJoinRequestRow[];
}

export function resolveAgentJoinRequest(input: {
  id: string;
  status: "approved" | "denied";
  actorId: string | null;
  note: string;
  resolvedByUserId: string;
}): void {
  sqlite
    .prepare(
      `UPDATE agent_join_requests
       SET status=?,
           actor_id=?,
           note=?,
           resolved_by_user_id=?,
           resolved_at=?
       WHERE id=? AND status='open'`,
    )
    .run(
      input.status,
      input.actorId,
      input.note,
      input.resolvedByUserId,
      new Date().toISOString(),
      input.id,
    );
}

export { sqlite };
