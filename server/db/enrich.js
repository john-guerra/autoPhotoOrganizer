/**
 * Metadata enrichment: read a photo's EXIF/dimensions and write them to the
 * index. ONE place, because there are two callers with very different rhythms
 * and they must not drift apart:
 *
 *  - /api/meta enriches the handful of photos the user just scrolled into view.
 *  - the sweep (/api/enrich) walks every photo nobody has read yet.
 *
 * If those two wrote rows differently, a photo's date/camera would depend on
 * *how* it happened to get indexed — and the date fallback in sort.js reads the
 * sentinels this file writes.
 *
 * SENTINELS (also documented at their readers):
 *  - `width` NULL = never attempted. 0 = attempted, no dimensions (RAW: sharp
 *    can't read most RAW headers). Only NULL means "try again" — storing NULL
 *    for a failed RAW would re-extract it forever.
 *  - `lens`/`camera` "" = EXIF attempted, nothing found.
 *  - `video_codec` NULL = never probed. "" = probed, no video stream. Same shape
 *    as `width`, and for the same reason: without the "" a video ffprobe can't
 *    read would come back pending on every sweep, forever.
 *  - `gps_checked` 0 = EXIF GPS has never been looked for. 1 = looked, whatever
 *    the answer. Photos indexed before places existed have a width and would
 *    otherwise never return here; this is the same "a column added late needs a
 *    way to be filled late" problem video_codec had.
 * Together they are why an un-read photo is distinguishable from a genuinely
 * date-less one, which is the whole basis of TAKEN_AT_EXPR's guard.
 */

import { placeFor } from "../lib/place.js";

/** The rows the sweep still owes work to.
 *
 * `width IS NULL` alone was not enough, and the gap was invisible: video_codec
 * and pix_fmt were added to the schema LATER than the videos themselves, so every
 * clip enriched before that already had a width and could never come back through
 * here. On the real library that left 1,171 of 1,173 videos unprobed — and an
 * unprobed video is one playback has to probe on demand, while the user waits
 * with the loupe open. A column added late needs a way to be filled late. */
const PENDING_CONDITION = `photos.stale = 0
    AND (photos.width IS NULL
         OR (photos.kind = 'video' AND photos.video_codec IS NULL)
         OR photos.gps_checked = 0)`;

/** Photos that have never had their metadata read, oldest id first.
 * @param {import("better-sqlite3").Database} db
 * @param {{limit?: number, folderId?: number|null}} [opts]
 * @returns {Array<{id:number, path:string}>}
 */
export function pendingMetaPhotos(db, { limit = 500, folderId = null } = {}) {
  return db
    .prepare(
      `SELECT photos.id AS id,
              folders.abs_path || '/' || photos.filename AS path
         FROM photos JOIN folders ON folders.id = photos.folder_id
        WHERE ${PENDING_CONDITION}
          ${folderId == null ? "" : "AND photos.folder_id = @folderId"}
        ORDER BY photos.id ASC
        LIMIT @limit`
    )
    .all({ limit, folderId });
}

/**
 * Photos by id, for a FORCED re-read (the "rescan these" action). Unlike
 * pendingMetaPhotos this ignores the width sentinel: the user is explicitly
 * asking us to look again at photos we have already read — because the EXIF
 * changed on disk, or an earlier read got it wrong. Stale rows are still
 * excluded; they aren't on disk to read.
 * @param {import("better-sqlite3").Database} db
 * @param {number[]} ids
 * @returns {Array<{id:number, path:string}>}
 */
export function photosByIds(db, ids) {
  if (!ids.length) return [];
  // CHUNKED, and that is not an optimisation. One `IN (?,?,…)` with a parameter
  // per id blows SQLite's host-parameter ceiling (SQLITE_MAX_VARIABLE_NUMBER,
  // 32766) the moment the user selects the whole library and asks for a re-read
  // — better-sqlite3 throws "too many SQL variables", and because the route is
  // an async handler Express 4 does not catch it, so the throw took the whole
  // SERVER down. ⌘A + Re-read metadata killed the app.
  const CHUNK = 500;
  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    rows.push(
      ...db
        .prepare(
          `SELECT photos.id AS id,
                  folders.abs_path || '/' || photos.filename AS path
             FROM photos JOIN folders ON folders.id = photos.folder_id
            WHERE photos.stale = 0 AND photos.id IN (${placeholders})
            ORDER BY photos.id ASC`
        )
        .all(...slice)
    );
  }
  return rows;
}

/** How many photos still have no metadata (drives the sweep's progress total).
 * @param {import("better-sqlite3").Database} db
 * @param {number|null} [folderId]
 * @returns {number}
 */
export function pendingMetaCount(db, folderId = null) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM photos
        WHERE ${PENDING_CONDITION}
          ${folderId == null ? "" : "AND photos.folder_id = @folderId"}`
    )
    .get({ folderId }).n;
}

/**
 * Write one processing.metadata() result to a photo row. Returns the fields as
 * stored, so a caller holding the row in memory can stay in sync without
 * re-reading it.
 * @param {import("better-sqlite3").Database} db
 * @param {number} id
 * @param {import("../processing/ProcessingService.js").MediaMetadata} m
 */
export function writeMeta(db, id, m) {
  const takenAtMs = m.createDate ? new Date(m.createDate).getTime() : null;
  const { country, city } = placeFor(m.lat ?? null, m.lon ?? null);
  const fields = {
    taken_at: takenAtMs,
    width: m.width ?? 0, // 0 = attempted, dimensionless (see sentinels above)
    height: m.height ?? 0,
    camera: m.camera ?? "",
    // duration carries no sentinel duty; NULL for images is fine.
    duration: m.duration ?? null,
    aperture: m.aperture ?? null,
    shutter: m.shutter ?? null,
    iso: m.iso ?? null,
    focal_length: m.focalLength ?? null,
    lens: m.lens ?? "",
    // What the stream actually is, so playback can tell whether the browser can
    // decode it (see lib/videoPlayback.js). "" — not NULL — when there was no
    // video stream to read: NULL means "never probed", and the sweep uses that to
    // decide who still owes it work. An image, or a video ffprobe chokes on, must
    // come out of the pending set once we've looked (see PENDING_CONDITION).
    video_codec: m.videoCodec ?? "",
    pix_fmt: m.pixFmt ?? null,
    lat: m.lat ?? null,
    lon: m.lon ?? null,
    // "" (not NULL) is the Unknown sentinel every dimension uses.
    place_country: country,
    place_city: city,
    gps_checked: 1,
  };
  db.prepare(
    `UPDATE photos SET taken_at = @taken_at, width = @width, height = @height,
       camera = @camera, duration = @duration, aperture = @aperture,
       shutter = @shutter, iso = @iso, focal_length = @focal_length,
       lens = @lens, video_codec = @video_codec, pix_fmt = @pix_fmt,
       lat = @lat, lon = @lon, place_country = @place_country,
       place_city = @place_city, gps_checked = @gps_checked
     WHERE id = @id`
  ).run({ ...fields, id });
  return fields;
}

/**
 * Enrich a batch: extract, then write each row inside ONE transaction so a
 * cancel or crash mid-sweep can't leave a half-written batch behind. Extraction
 * happens outside the transaction — it's the slow part (disk + decode) and
 * SQLite must not be held open across it.
 * @param {import("better-sqlite3").Database} db
 * @param {import("../processing/ProcessingService.js").ProcessingService} processing
 * @param {Array<{id:number, path:string}>} photos
 * @returns {Promise<number>} how many rows were written
 */
export async function enrichBatch(db, processing, photos) {
  if (!photos.length) return 0;
  const metas = await processing.metadata(photos.map((p) => p.path));
  const write = db.transaction(() => {
    metas.forEach((m, i) => writeMeta(db, photos[i].id, m));
  });
  write();
  return metas.length;
}
