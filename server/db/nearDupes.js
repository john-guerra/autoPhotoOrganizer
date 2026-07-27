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
 * Ids per `IN (...)` clause.
 *
 * Not defensive padding: measured on this build, a prepared statement accepts
 * 32,766 parameters and throws "too many SQL variables" at 32,767. A selection
 * is user-sized — select-all on the library this was built against is 34,812
 * photos — so an unchunked query is not a theoretical risk, it is the
 * select-all path failing outright. 900 is the conventional safe floor across
 * SQLite builds, well under the measured ceiling.
 */
const ID_CHUNK = 900;

function* chunked(list, size) {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}

/**
 * The same counts as `nearDupeCounts`, restricted to a set of photos (#211).
 *
 * ## Why this exists instead of a scoped SWEEP
 *
 * #211 asked to run duplicate detection over just a selection, and framed it as
 * a choice between splicing the selection's groups into the stored grouping
 * (inconsistent — a photo just outside the selection can be a real duplicate of
 * one inside it and would never say so) and replacing the grouping wholesale
 * (destroys the rest of the library's grouping from a button that claims to act
 * on a selection).
 *
 * Measured, the premise does not hold: a whole-library pass over this library's
 * 16,797 embedded photos is 3.2s at the default 60s window (server/ml/
 * nearDupeSweep.js is SQLite plus arithmetic — it never touches a file, and it
 * retires groups past the window so cost tracks window DENSITY, not library
 * size). Scoping the computation would buy nothing and cost consistency, so the
 * sweep stays whole-library and only the ANSWER is scoped. Both horns of the
 * dilemma disappear.
 *
 * `spillGroups` is the honest part of the report. A group counted here is one
 * the selection TOUCHES; it may have members outside the selection, and saying
 * "12 groups in your 200 photos" while some of those groups reach photos the
 * user did not select would overstate what was found. The caller surfaces it.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @param {number[]} ids
 * @returns {{photos: number, groups: number, spillGroups: number}}
 */
export function nearDupeCountsForIds(db, model, ids) {
  if (!ids?.length) return { photos: 0, groups: 0, spillGroups: 0 };

  // Pass 1: how many of the SELECTED photos each touched group contributes.
  /** @type {Map<number, number>} */
  const selectedPerGroup = new Map();
  let photos = 0;
  for (const chunk of chunked(ids, ID_CHUNK)) {
    const rows = db
      .prepare(
        `SELECT group_id FROM near_dupe_groups
          WHERE model = ? AND photo_id IN (${chunk.map(() => "?").join(",")})`
      )
      .all(model, ...chunk);
    photos += rows.length;
    for (const r of rows)
      selectedPerGroup.set(
        r.group_id,
        (selectedPerGroup.get(r.group_id) ?? 0) + 1
      );
  }

  // Pass 2: each touched group's TOTAL size, so a group reaching beyond the
  // selection can be reported as such rather than silently counted as if it
  // were contained.
  let spillGroups = 0;
  const groupIds = [...selectedPerGroup.keys()];
  for (const chunk of chunked(groupIds, ID_CHUNK)) {
    const rows = db
      .prepare(
        `SELECT group_id, COUNT(*) AS total FROM near_dupe_groups
          WHERE model = ? AND group_id IN (${chunk.map(() => "?").join(",")})
          GROUP BY group_id`
      )
      .all(model, ...chunk);
    for (const r of rows)
      if (r.total > (selectedPerGroup.get(r.group_id) ?? 0)) spillGroups++;
  }

  return { photos, groups: selectedPerGroup.size, spillGroups };
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

/**
 * Replace the neighbour-similarity table (#216) — how alike each photo is to
 * the one immediately before it in capture time.
 *
 * Wholesale, in one transaction, for the same reason the grouping is: insert a
 * photo in the middle of a sequence and every downstream neighbour changes, so
 * there is no correct per-row update and no partial state worth keeping.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @param {Array<{photoId: number, prevId: number, sim: number}>} rows
 * @returns {{rows: number}}
 */
export function replaceNeighborSim(db, model, rows) {
  const wipe = db.prepare(`DELETE FROM photo_neighbor_sim WHERE model = ?`);
  const insert = db.prepare(
    `INSERT INTO photo_neighbor_sim (photo_id, prev_id, sim, model)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(photo_id) DO UPDATE SET prev_id = excluded.prev_id,
                                         sim     = excluded.sim,
                                         model   = excluded.model`
  );
  const run = db.transaction(() => {
    wipe.run(model);
    for (const r of rows) insert.run(r.photoId, r.prevId, r.sim, model);
  });
  run();
  return { rows: rows.length };
}

/** Test/inspection helper: the stored neighbour similarity for one photo. */
export function neighborSim(db, photoId) {
  return (
    db
      .prepare(
        `SELECT prev_id AS prevId, sim FROM photo_neighbor_sim WHERE photo_id = ?`
      )
      .get(photoId) ?? null
  );
}
