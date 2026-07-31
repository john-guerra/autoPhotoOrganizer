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
  const clean = Array.isArray(ids)
    ? ids.filter((n) => Number.isInteger(n))
    : [];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO keep_scope (photo_id) VALUES (?)`
  );
  const swap = db.transaction((rows) => {
    db.prepare(`DELETE FROM keep_scope`).run();
    for (const id of rows) insert.run(id);
  });
  swap(clean);
  return db.prepare(`SELECT COUNT(*) AS n FROM keep_scope`).get().n;
}

/**
 * The working set, as ids the client can trust (#212).
 *
 * This is what makes "keep only" survive a reload: the table already outlived
 * the page, but nothing could read it back, so the UI booted showing the whole
 * library while the server still held the scope — one side remembering and the
 * other not.
 *
 * INNER JOIN photos, deliberately. `keep_scope` carries no foreign key (see
 * schema.js), so removing a folder leaves its ids behind. The feed never
 * noticed, because `buildFilter` phrases the restriction
 * `photos.id IN (SELECT photo_id FROM keep_scope)` and a dead id simply matches
 * nothing — but a restore that trusted the raw table would put a count on the
 * scope chip that the grid below it contradicts.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {number[]} ascending; empty when no scope is in force
 */
export function keepScopeIds(db) {
  return db
    .prepare(
      `SELECT keep_scope.photo_id AS id
         FROM keep_scope
         JOIN photos ON photos.id = keep_scope.photo_id
        ORDER BY keep_scope.photo_id`
    )
    .all()
    .map((r) => r.id);
}
