import { SORT_ATTRS } from "./sort.js";

/**
 * Storage for the near-duplicate grouping (#162): which photos the embedding
 * sweep decided are the SAME SHOT as which others.
 *
 * `group_id` is an opaque component label. Equal values mean "same group" and
 * nothing else — the numbers are not stable across sweeps, carry no ordering,
 * and must never be shown to a user or persisted anywhere as an identity. A
 * grouping is replaced wholesale, never patched, so a photo's label routinely
 * changes without its group's membership changing at all.
 */

/**
 * Photos with a vector under `model`, in the same effective-capture-time order
 * the feed uses, so the sweep's window walk matches what the user will see.
 *
 * The time expression is imported from sort.js rather than hand-written, and
 * it is specifically `date_taken`'s — the UNCONDITIONAL
 * `COALESCE(taken_at, btime, mtime)`, which is the exact SQL twin of what
 * bursts.js computes client-side (`toMs(item.takenAt) ?? item.mtimeMs`). Not
 * `TAKEN_AT_EXPR`, which is deliberately guarded on `width IS NOT NULL` and
 * yields NULL for a photo whose EXIF has not been read yet: that guard is
 * right for date GROUPING (an un-read photo belongs in "Unknown" rather than
 * being filed under a guessed date) and wrong here, where a NULL would drop
 * the photo out of the window walk entirely and silently exclude every
 * un-enriched photo from near-dupe detection.
 *
 * Ordering by a different notion of "when" than the grid uses would group
 * frames the user sees as non-adjacent — a bug with no error and no failing
 * query, which is why this is imported and not copied.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {Array<{id: number, time: number, dim: number, scale: number, vec: Buffer}>}
 */
export function embeddedPhotosInTimeOrder(db, model) {
  return db
    .prepare(
      `SELECT photos.id                     AS id,
              ${SORT_ATTRS.date_taken.expr}  AS time,
              e.dim           AS dim,
              e.scale         AS scale,
              e.vec           AS vec
         FROM photos
         JOIN photo_embeddings e
           ON e.photo_id = photos.id AND e.model = ?
        WHERE photos.stale = 0
        ORDER BY time ASC, photos.id ASC`
    )
    .all(model);
}

/**
 * Replace the whole grouping for `model` in one transaction.
 *
 * Wholesale replacement rather than an incremental patch, because a near-dupe
 * group is not a property of one photo: adding a single new photo to the
 * library can merge two groups that were previously separate, and deleting one
 * can split a group in two. There is no correct per-row update, so there is no
 * partial state worth keeping. The transaction is what stops a cancelled or
 * crashed sweep from leaving a half-old, half-new grouping — which would look
 * exactly like a working one.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @param {Array<{photoId: number, groupId: number}>} rows
 * @returns {{photos: number, groups: number}}
 */
export function replaceNearDupeGroups(db, model, rows) {
  const wipe = db.prepare(`DELETE FROM near_dupe_groups WHERE model = ?`);
  const insert = db.prepare(
    `INSERT INTO near_dupe_groups (photo_id, group_id, model, computed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(photo_id) DO UPDATE SET group_id    = excluded.group_id,
                                         model       = excluded.model,
                                         computed_at = excluded.computed_at`
  );
  // One timestamp for the whole grouping, taken ONCE before the transaction
  // rather than per row: a wholesale replacement happened at a moment, and
  // letting each row stamp itself would make MAX(computed_at) drift by however
  // long the write took.
  const at = Date.now();
  const run = db.transaction(() => {
    wipe.run(model);
    for (const r of rows) insert.run(r.photoId, r.groupId, model, at);
  });
  run();
  return {
    photos: rows.length,
    groups: new Set(rows.map((r) => r.groupId)).size,
  };
}

/**
 * What the settings panel reports. `photos` counts photos IN a group, not
 * photos considered — a photo with no near-duplicate is the overwhelmingly
 * common case and is simply absent from the table.
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @returns {{photos: number, groups: number}}
 */
export function nearDupeCounts(db, model) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS photos, COUNT(DISTINCT group_id) AS groups,
              MAX(computed_at) AS computedAt
         FROM near_dupe_groups WHERE model = ?`
    )
    .get(model);
  return {
    photos: row?.photos ?? 0,
    groups: row?.groups ?? 0,
    // 0 means "a grouping exists but predates this column" (a library upgraded
    // across user_version 4); null means there is no grouping at all. The
    // panel must distinguish them — "last run: unknown" is not "never run".
    computedAt: row?.photos ? (row.computedAt ?? 0) : null,
  };
}

/**
 * Drop every grouping, for every model. Called when the setting that PRODUCED
 * the grouping changes (threshold, window, model): the rows on disk describe a
 * decision the user has just revoked, and leaving them until the next sweep
 * finishes would keep stacking photos by a rule no longer in force — silently,
 * and with the settings panel showing the new number.
 * @param {import("better-sqlite3").Database} db
 */
export function clearNearDupeGroups(db) {
  db.prepare(`DELETE FROM near_dupe_groups`).run();
}
