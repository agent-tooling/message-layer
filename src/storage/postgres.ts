/**
 * Postgres storage adapter for message-layer.
 *
 * Import path: `message-layer/storage/postgres`
 *
 * @example
 * ```typescript
 * import { startServer } from "message-layer";
 * import { postgres } from "message-layer/storage/postgres";
 *
 * await startServer({
 *   config: {
 *     storage: postgres(process.env.DATABASE_URL!),
 *     ...
 *   },
 * });
 * ```
 *
 * You can also create the database directly for in-process embedding:
 * ```typescript
 * import { createPostgresDatabase } from "message-layer/storage/postgres";
 * import { MessageLayer } from "message-layer";
 *
 * const db = await createPostgresDatabase(process.env.DATABASE_URL!);
 * const service = new MessageLayer(db);
 * ```
 */

export { createPostgresDatabase } from "../db.js";

/**
 * Returns a `storage` config descriptor for Postgres.
 *
 * Pass the result directly as `config.storage` in `startServer`.
 *
 * @param connectionString - A valid Postgres connection string, e.g.
 *   `"postgresql://user:pass@localhost:5432/mydb"`.
 *   Neon serverless Postgres URLs are supported via TLS.
 */
export function postgres(connectionString: string): { adapter: "postgres"; path: string } {
  if (!connectionString || connectionString.trim().length === 0) {
    throw new Error("postgres: connectionString must be non-empty");
  }
  return { adapter: "postgres", path: connectionString };
}
