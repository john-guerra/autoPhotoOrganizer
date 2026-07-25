import { placeFor, PLACE_VERSION } from "../lib/place.js";

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
 * offline-mirror invariant, and it costs no I/O.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {{updated: number}}
 */
export function backfillPlaces(db) {
  // Cheap gate FIRST. In the common case (nothing to do) this is the only
  // work that happens, and in particular the geocoder's ~1s/~80MB dataset is
  // never loaded — placeFor builds it lazily on first call.
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM photos
        WHERE lat IS NOT NULL AND place_version < ?`
    )
    .get(PLACE_VERSION);
  if (!n) return { updated: 0 };

  const rows = db
    .prepare(
      `SELECT id, lat, lon FROM photos
        WHERE lat IS NOT NULL AND place_version < ?`
    )
    .all(PLACE_VERSION);

  const update = db.prepare(
    `UPDATE photos
        SET place_country = @country, place_city = @city,
            place_version = @version
      WHERE id = @id`
  );
  const run = db.transaction((batch) => {
    for (const row of batch) {
      const { country, city } = placeFor(row.lat, row.lon);
      update.run({ id: row.id, country, city, version: PLACE_VERSION });
    }
  });
  run(rows);
  return { updated: rows.length };
}

/**
 * Photos with no GPS never need re-placing, but they must not be re-examined on
 * every startup either — the gate above would keep finding them. They are
 * stamped in bulk, separately from the loop, because there is nothing to
 * compute for them.
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
