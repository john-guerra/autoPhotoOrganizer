/**
 * The single active "keep only" working set, stored in the keep_scope table so
 * an arbitrarily large scope is referenced by a boolean filter flag rather than
 * shipped as ids in a URL query param. Replacing is atomic (whole set swapped in
 * one transaction) so feed/tree/count queries never see a half-written scope.
 */

/**
 * Replace the keep-only set with `ids` (empty array clears it).
 * @param {import("better-sqlite3").Database} db
 * @param {number[]} ids
 * @returns {number} the number of ids stored
 */
export function setKeepScope(db, ids) {
  const clean = Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)) : [];
  const insert = db.prepare(`INSERT OR IGNORE INTO keep_scope (photo_id) VALUES (?)`);
  const swap = db.transaction((rows) => {
    db.prepare(`DELETE FROM keep_scope`).run();
    for (const id of rows) insert.run(id);
  });
  swap(clean);
  return db.prepare(`SELECT COUNT(*) AS n FROM keep_scope`).get().n;
}
