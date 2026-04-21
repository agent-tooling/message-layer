/**
 * PGlite storage adapter for message-layer.
 *
 * Import path: `message-layer/storage/pglite`
 *
 * @example
 * ```typescript
 * import { startServer } from "message-layer";
 * import { pglite } from "message-layer/storage/pglite";
 *
 * // Persistent on-disk PGlite database
 * await startServer({ config: { storage: pglite("./.data/db"), ... } });
 *
 * // Ephemeral in-memory database (useful for tests)
 * await startServer({ config: { storage: pglite("memory://test"), ... } });
 * ```
 *
 * You can also create the database directly for in-process embedding:
 * ```typescript
 * import { createPgliteDatabase } from "message-layer/storage/pglite";
 * import { MessageLayer } from "message-layer";
 *
 * const db = await createPgliteDatabase("./.data/db");
 * const service = new MessageLayer(db);
 * ```
 */

export { createPgliteDatabase } from "../db.js";

/**
 * Returns a `storage` config descriptor for PGlite.
 *
 * Pass the result directly as `config.storage` in `startServer`.
 *
 * @param path - File system path (e.g. `"./.data/mydb"`) or
 *   `"memory://<name>"` for an in-process ephemeral database.
 *   Defaults to `"memory://default"`.
 */
export function pglite(path = "memory://default"): { adapter: "pglite"; path: string } {
  return { adapter: "pglite", path };
}
