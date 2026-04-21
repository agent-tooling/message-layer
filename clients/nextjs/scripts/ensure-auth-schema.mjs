import { mkdirSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

function resolveDataDir() {
  const input = process.env.TEAM_CLIENT_DATA_DIR;
  if (!input || input.length === 0) {
    return join(process.cwd(), ".data");
  }
  return isAbsolute(input) ? input : join(process.cwd(), input);
}

function hasAuthSchema(dbPath) {
  if (!existsSync(dbPath)) {
    return false;
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const required = ["user", "session", "account"];
    for (const table of required) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      if (!row) {
        return false;
      }
    }
    return true;
  } finally {
    db.close();
  }
}

const dataDir = resolveDataDir();
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, "better-auth.db");

if (!hasAuthSchema(dbPath)) {
  const result = spawnSync(
    "pnpm",
    ["dlx", "@better-auth/cli", "migrate", "--config", "./lib/auth.ts", "--yes"],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
