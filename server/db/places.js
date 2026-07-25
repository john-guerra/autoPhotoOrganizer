import { placeFor, PLACE_VERSION } from "../lib/place.js";
import { whenIdle } from "../lib/interactive.js";

/**
 * Re-derive stored place names when the geocoder changes underneath them.
 *
 * This exists because `gps_checked = 1` is a ONE-WAY door: it means "we have
 * read this photo's EXIF GPS", so the metadata sweep will never revisit the
 * row (see PENDING_CONDITION in enrich.js). That is the right behaviour for
 * reading a file — the EXIF cannot change — but it also froze the *derived*
 * place names, so improving the geocoder would have left every already-scanned
 * photo showing its old, wrong answer forever. That is exactly what #175 hit:
 * San Francisco photos permanently labelled "Half Moon Bay".
 *
 * The re-derive needs no file access at all — lat/lon are already in the
 * index — so it works with the source drive unmounted, in line with the
 * offline-mirror invariant.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{limit?: number}} [opts]
 * @returns {{updated: number, remaining: boolean}}
 */
export function backfillPlacesBatch(db, { limit = 200 } = {}) {
  // No ORDER BY: unlike the metadata sweep, there is no product meaning to
  // "oldest id first" here, and adding one defeats idx_photos_place_version —
  // SQLite prefers a rowid scan over an index SEARCH once it has to satisfy an
  // ORDER BY that the index doesn't itself provide. Caught by queryPlan.test.js.
  const rows = db
    .prepare(
      `SELECT id, lat, lon FROM photos
        WHERE lat IS NOT NULL AND place_version < ?
        LIMIT ?`
    )
    .all(PLACE_VERSION, limit);
  if (!rows.length) return { updated: 0, remaining: false };

  const update = db.prepare(
    `UPDATE photos
        SET place_country = @country, place_region = @region, place_city = @city,
            place_version = @version
      WHERE id = @id`
  );
  const run = db.transaction((batch) => {
    for (const row of batch) {
      const { country, region, city } = placeFor(row.lat, row.lon);
      update.run({ id: row.id, country, region, city, version: PLACE_VERSION });
    }
  });
  run(rows);
  return { updated: rows.length, remaining: rows.length === limit };
}

let backfillInFlight = false;

/**
 * Drain `backfillPlacesBatch` to completion in the background.
 *
 * Idle-gated and batched, mirroring `db/hashing.js`'s `hashAllPending` — the
 * established pattern for "catch up the whole library" work in this codebase
 * — for the same reason: a naive single transaction over a 100k+-photo
 * library blocked the ENTIRE app (this ran at `getDb()`, before
 * `app.listen()`, with no progress shown — the exact silent-frozen-app
 * failure CLAUDE.md's Usability section rules out) the first time
 * PLACE_VERSION actually moved. Single-flight: a second caller while one is
 * already draining is a no-op, since the running loop already re-queries the
 * pending set every batch.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{limit?: number, idle?: () => Promise<void>}} [opts]
 * @returns {Promise<{updated: number, alreadyRunning?: boolean}>}
 */
export async function backfillPlaces(
  db,
  { limit = 200, idle = whenIdle } = {}
) {
  if (backfillInFlight) return { updated: 0, alreadyRunning: true };
  backfillInFlight = true;
  let updated = 0;
  try {
    for (;;) {
      await idle();
      const batch = backfillPlacesBatch(db, { limit });
      updated += batch.updated;
      if (!batch.remaining) break;
    }
  } finally {
    backfillInFlight = false;
  }
  return { updated };
}

/** Test-only: clear the single-flight latch between cases. */
export function _resetBackfillForTest() {
  backfillInFlight = false;
}

/**
 * Photos with no GPS never need re-placing, but they must not be re-examined on
 * every startup either — the gate above would keep finding them. Stamped in
 * one bulk UPDATE rather than batched: unlike backfillPlacesBatch there is no
 * per-row JS computation (no placeFor() call), so even a 100k-row match is a
 * single fast index range scan (idx_photos_place_version), not a loop.
 * @param {import("better-sqlite3").Database} db
 */
export function stampPlacelessPhotos(db) {
  const info = db
    .prepare(
      `UPDATE photos SET place_version = ?
        WHERE lat IS NULL AND gps_checked = 1 AND place_version < ?`
    )
    .run(PLACE_VERSION, PLACE_VERSION);
  return { stamped: info.changes };
}
