/**
 * Manual burst-stack overrides (issue #24). Two complementary, mutually-
 * exclusive per-photo states layered on top of the automatic, client-side
 * burst detection (ui/src/lib/bursts.js):
 *
 *   - "manually grouped": rows in `manual_stacks` sharing a `group_id` are
 *     forced into one stack, regardless of the time-gap heuristic.
 *   - "kept separate": `photos.no_auto_stack = 1` means the photo never
 *     auto-stacks again (the dissolve action).
 *
 * A photo is in exactly one of three states — auto (neither), grouped, or
 * kept-separate — and every write here keeps those from contradicting each
 * other. Both key on photo `id` (like preferred_cover / keep_scope) and survive
 * rescans of unchanged files via upsertScan preserving the row. Transactions
 * throughout (better-sqlite3 is synchronous, so MAX(group_id)+1 is race-free).
 */

/** SQL placeholder list (`?,?,?`) for an id array. Ids are integers — no
 * injection surface. */
function placeholders(n) {
  return new Array(n).fill("?").join(",");
}

/**
 * Force `ids` into a single new manual stack. Clears any "keep separate" flag on
 * those photos and removes them from any prior manual stack first, so re-grouping
 * is idempotent and the three-state invariant holds.
 * @param {import("better-sqlite3").Database} db
 * @param {number[]} ids
 * @returns {{groupId:number, count:number}}
 */
export function createManualStack(db, ids) {
  const clean = [
    ...new Set(
      Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)) : []
    ),
  ];
  if (clean.length < 2) {
    throw new Error("a manual stack needs at least 2 photos");
  }
  const ph = placeholders(clean.length);
  const run = db.transaction(() => {
    const groupId = db
      .prepare(`SELECT COALESCE(MAX(group_id), 0) + 1 AS g FROM manual_stacks`)
      .get().g;
    db.prepare(`UPDATE photos SET no_auto_stack = 0 WHERE id IN (${ph})`).run(
      ...clean
    );
    db.prepare(`DELETE FROM manual_stacks WHERE photo_id IN (${ph})`).run(
      ...clean
    );
    const insert = db.prepare(
      `INSERT INTO manual_stacks (photo_id, group_id) VALUES (?, ?)`
    );
    for (const id of clean) insert.run(id, groupId);
    return groupId;
  });
  const groupId = run();
  return { groupId, count: clean.length };
}

/**
 * Dissolve: mark `ids` as "keep separate" (they never auto-stack again) and pull
 * them out of any manual stack. Covers both a false-positive AUTO stack and a
 * previously hand-built manual one.
 * @param {import("better-sqlite3").Database} db
 * @param {number[]} ids
 * @returns {{count:number}}
 */
export function dissolveStack(db, ids) {
  const clean = [
    ...new Set(
      Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)) : []
    ),
  ];
  if (!clean.length) return { count: 0 };
  const ph = placeholders(clean.length);
  const run = db.transaction(() => {
    db.prepare(`UPDATE photos SET no_auto_stack = 1 WHERE id IN (${ph})`).run(
      ...clean
    );
    db.prepare(`DELETE FROM manual_stacks WHERE photo_id IN (${ph})`).run(
      ...clean
    );
  });
  run();
  return { count: clean.length };
}

/** @param {import("better-sqlite3").Database} db @param {number} photoId @returns {number|null} */
export function getManualStackId(db, photoId) {
  const row = db
    .prepare(`SELECT group_id FROM manual_stacks WHERE photo_id = ?`)
    .get(photoId);
  return row ? row.group_id : null;
}

/** @param {import("better-sqlite3").Database} db @param {number} photoId @returns {boolean} */
export function isKeptSeparate(db, photoId) {
  const row = db
    .prepare(`SELECT no_auto_stack FROM photos WHERE id = ?`)
    .get(photoId);
  return row ? row.no_auto_stack === 1 : false;
}
