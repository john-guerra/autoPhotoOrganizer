/**
 * Saved semantic tags (#164) — a search result the user decided to keep.
 *
 * ## Why saving is a separate act from searching
 *
 * The search itself is disposable and costs nothing: ranking the whole library
 * against a phrase is ~10 ms over vectors already stored, so there is no
 * benefit to persisting a result "just in case". What persistence buys is a
 * DECISION — the user looked at a ranked list, saw where it stopped being
 * dogs, and drew the line. That judgement is not reproducible from the model
 * (there is no threshold that means "dog"; see server/ml/textSearch.js), so it
 * is the one thing actually worth storing.
 *
 * ## The tables were built for this
 *
 * `tags` / `photo_tags` have been in the schema since the beginning and, until
 * now, written by nothing. `tags(dimension_name, value)` is keyed by the
 * dimension-registry name, and `photo_tags.source` separates model output from
 * a manual edit — so a hand-removed photo can survive a later re-save. Both
 * were designed for exactly this feature.
 *
 * `DIMENSION` is the registry name these rows live under. Kept as one constant
 * because it appears in the storage key AND in the filter facet, and the two
 * silently stop matching if they drift.
 */

export const DIMENSION = "semantic";

/** Ids per `IN (...)` clause — see server/db/nearDupes.js for the measured
 *  ceiling (32,766) and why a user-sized id list must never be trusted to
 *  fit in one statement. */
const ID_CHUNK = 900;

function* chunked(list, size) {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}

/**
 * Create (or reuse) a tag and set its members to exactly `photoIds`.
 *
 * REPLACES the tag's membership rather than adding to it. Saving "sunset"
 * twice must leave the tag meaning the second save, not the union of both —
 * a user who narrows a cut from 200 photos to 80 and saves again is
 * correcting the tag, and a union would make that correction impossible to
 * express.
 *
 * Rows the user marked by hand (`source = 'manual'`) are preserved: a re-save
 * is the model's opinion changing, and it has no business discarding a
 * decision a person made. This is the whole reason `photo_tags.source` exists.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} value the phrase, as the user typed it
 * @param {number[]} photoIds
 * @returns {{tagId: number, photos: number, keptManual: number}}
 */
export function saveTag(db, value, photoIds) {
  const name = value.trim();
  if (!name) throw new Error("a tag needs a name");
  const ids = [...new Set(photoIds.filter(Number.isInteger))];

  return db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO tags (dimension_name, value) VALUES (?, ?)`
    ).run(DIMENSION, name);
    const { id: tagId } = db
      .prepare(`SELECT id FROM tags WHERE dimension_name = ? AND value = ?`)
      .get(DIMENSION, name);

    const keptManual = db
      .prepare(
        `SELECT COUNT(*) AS n FROM photo_tags WHERE tag_id = ? AND source = 'manual'`
      )
      .get(tagId).n;

    db.prepare(
      `DELETE FROM photo_tags WHERE tag_id = ? AND source <> 'manual'`
    ).run(tagId);

    const insert = db.prepare(
      `INSERT OR IGNORE INTO photo_tags (photo_id, tag_id, source)
       VALUES (?, ?, 'model')`
    );
    for (const id of ids) insert.run(id, tagId);

    const photos = db
      .prepare(`SELECT COUNT(*) AS n FROM photo_tags WHERE tag_id = ?`)
      .get(tagId).n;
    return { tagId, photos, keptManual };
  })();
}

/**
 * Every saved tag with its photo count, for the filter menu.
 * @param {import("better-sqlite3").Database} db
 * @returns {Array<{id: number, value: string, photos: number}>}
 */
export function listTags(db) {
  return db
    .prepare(
      `SELECT t.id, t.value, COUNT(pt.photo_id) AS photos
         FROM tags t LEFT JOIN photo_tags pt ON pt.tag_id = t.id
        WHERE t.dimension_name = ?
        GROUP BY t.id, t.value
        ORDER BY t.value COLLATE NOCASE`
    )
    .all(DIMENSION);
}

/**
 * Delete a tag and its memberships.
 * @param {import("better-sqlite3").Database} db
 * @param {string} value
 * @returns {{removed: number}}
 */
export function deleteTag(db, value) {
  return db.transaction(() => {
    const row = db
      .prepare(`SELECT id FROM tags WHERE dimension_name = ? AND value = ?`)
      .get(DIMENSION, value);
    if (!row) return { removed: 0 };
    db.prepare(`DELETE FROM photo_tags WHERE tag_id = ?`).run(row.id);
    db.prepare(`DELETE FROM tags WHERE id = ?`).run(row.id);
    return { removed: 1 };
  })();
}

/**
 * Which of `photoIds` carry the tag — so the search panel can show what is
 * already saved without re-reading the whole membership.
 * @param {import("better-sqlite3").Database} db
 * @param {string} value
 * @param {number[]} photoIds
 * @returns {Set<number>}
 */
export function taggedAmong(db, value, photoIds) {
  const out = new Set();
  if (!photoIds?.length) return out;
  for (const chunk of chunked(photoIds, ID_CHUNK)) {
    const rows = db
      .prepare(
        `SELECT pt.photo_id AS id FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
          WHERE t.dimension_name = ? AND t.value = ?
            AND pt.photo_id IN (${chunk.map(() => "?").join(",")})`
      )
      .all(DIMENSION, value, ...chunk);
    for (const r of rows) out.add(r.id);
  }
  return out;
}
