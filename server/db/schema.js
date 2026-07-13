export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS volumes (
  id INTEGER PRIMARY KEY,
  label TEXT,
  uuid TEXT UNIQUE,
  last_mount_path TEXT,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  abs_path TEXT NOT NULL UNIQUE,
  volume_id INTEGER REFERENCES volumes(id),
  last_scanned_at INTEGER
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES folders(id),
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  btime INTEGER,
  content_hash TEXT,
  taken_at INTEGER,
  width INTEGER,
  height INTEGER,
  camera TEXT,
  kind TEXT NOT NULL,
  perceptual_hash TEXT,
  rating INTEGER NOT NULL DEFAULT 0,
  preferred_cover INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  UNIQUE(folder_id, filename)
);
CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_content_hash ON photos(content_hash);

CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY,
  name TEXT,
  start_at INTEGER,
  end_at INTEGER
);
CREATE TABLE IF NOT EXISTS photo_album (
  photo_id INTEGER REFERENCES photos(id),
  album_id INTEGER REFERENCES albums(id),
  PRIMARY KEY (photo_id, album_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  dimension_name TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(dimension_name, value)
);
CREATE TABLE IF NOT EXISTS photo_tags (
  photo_id INTEGER REFERENCES photos(id),
  tag_id INTEGER REFERENCES tags(id),
  source TEXT NOT NULL,
  PRIMARY KEY (photo_id, tag_id)
);
-- The single active "keep only" working set. Membership is referenced by the
-- filter's keepScope flag (photos.id IN (SELECT photo_id FROM keep_scope)) so an
-- arbitrarily large scope never has to travel in a URL query param.
CREATE TABLE IF NOT EXISTS keep_scope (
  photo_id INTEGER PRIMARY KEY
);
-- Manual burst-stack grouping (issue #24): photos sharing a group_id are forced
-- into one stack regardless of the time-gap heuristic. A photo can belong to at
-- most one manual stack (PK on photo_id). The complementary "keep separate"
-- override (dissolve) is the photos.no_auto_stack column. See
-- docs/superpowers/specs/2026-07-11-manual-burst-override-design.md.
CREATE TABLE IF NOT EXISTS manual_stacks (
  photo_id INTEGER PRIMARY KEY REFERENCES photos(id),
  group_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_manual_stacks_group ON manual_stacks(group_id);
`;

/** @param {import("better-sqlite3").Database} db */
export function applySchema(db) {
  db.exec(SCHEMA_SQL);
  ensureColumn(db, "photos", "btime", "INTEGER");
  // "Keep separate" (dissolve) marker — a per-photo boolean like preferred_cover,
  // so it rides upsertScan's ON CONFLICT and survives rescans of unchanged files.
  ensureColumn(db, "photos", "no_auto_stack", "INTEGER NOT NULL DEFAULT 0");
  // Video length in seconds (fractional; NULL for images and un-probed videos).
  ensureColumn(db, "photos", "duration", "REAL");
  // Loupe details panel EXIF (issue #27). Nullable — populated lazily by
  // /api/meta on first detailed view; `lens` doubles as the "EXIF attempted"
  // sentinel (see NodeProcessingService.exifToMeta / api.js /api/meta trigger).
  ensureColumn(db, "photos", "aperture", "REAL");
  ensureColumn(db, "photos", "shutter", "REAL");
  ensureColumn(db, "photos", "iso", "INTEGER");
  ensureColumn(db, "photos", "focal_length", "REAL");
  ensureColumn(db, "photos", "lens", "TEXT");
  // Video stream format, so playback knows whether the BROWSER can decode this
  // file or whether it needs a transcoded proxy first (see lib/videoPlayback.js
  // — Chromium has no MPEG-4 Part 2 decoder, which is why a camcorder .avi
  // plays its audio and shows a black frame). NULL for images and for videos
  // indexed before this column existed; playback probes those on demand.
  ensureColumn(db, "photos", "video_codec", "TEXT");
  ensureColumn(db, "photos", "pix_fmt", "TEXT");
}

/** Idempotent ADD COLUMN — the app ships no migration runner, and
 *  CREATE TABLE IF NOT EXISTS never alters an existing table. */
function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
