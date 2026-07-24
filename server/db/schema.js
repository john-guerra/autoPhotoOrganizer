import { feedIndexes, FEED_INDEX_PREFIX } from "./sort.js";

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
  // The folder feed's ORDER BY key: abs_path with "/" replaced by char(1), which
  // sorts below every character a path can contain. That turns byte order into a
  // pre-order walk of the folder tree, so a folder's children immediately follow
  // it and a subtree stays contiguous — the precondition for nesting folders in
  // the feed. Byte order does NOT do this: "/Selectas copy" sorts between
  // "/Selectas" and "/Selectas/…" (' ' 0x20 < '/' 0x2F). See db/feed.js.
  //
  // VIRTUAL, not STORED: SQLite only permits adding a VIRTUAL generated column
  // via ALTER TABLE, and this app ships no migration runner. Costs nothing — the
  // index below materializes the value, which is what the ORDER BY actually reads.
  ensureColumn(
    db,
    "folders",
    "sort_path",
    "TEXT GENERATED ALWAYS AS (replace(abs_path, '/', char(1))) VIRTUAL"
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_folders_sort_path ON folders(sort_path)`
  );
  ensureColumn(db, "photos", "btime", "INTEGER");
  // "Keep separate" (dissolve) marker — a per-photo boolean like preferred_cover,
  // so it rides upsertScan's ON CONFLICT and survives rescans of unchanged files.
  ensureColumn(db, "photos", "no_auto_stack", "INTEGER NOT NULL DEFAULT 0");
  // Missing-files review (#1). `dismissed` is a recoverable tombstone: a stale
  // row the user removed from the index, hidden everywhere but never deleted, so
  // its rating survives and is restored if the file reappears. `first_seen_at`
  // (set on INSERT, never updated) distinguishes a row that appeared THIS scan
  // (a candidate move target) from a pre-existing copy — the signal that keeps
  // auto-relocate from repointing onto an existing backup. See db/missing.js.
  ensureColumn(db, "photos", "dismissed", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "photos", "first_seen_at", "INTEGER");
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
  // Content-hash sweep bookkeeping (#12/#86). `hash_attempted` mirrors the
  // metadata sweep's "mark attempted" trick: an unreadable file keeps
  // content_hash NULL but sets hash_attempted=1 so the background hasher
  // (db/hashing.js hashAllPending) can't re-select the same failing rows forever.
  // No dedicated pending-index is needed (unlike idx_photos_pending_meta): the
  // existing idx_photos_content_hash already turns the per-batch
  // "content_hash IS NULL" lookup into an index SEARCH, not a 100k full scan
  // (verified via EXPLAIN QUERY PLAN), and LIMIT caps it regardless.
  ensureColumn(db, "photos", "hash_attempted", "INTEGER NOT NULL DEFAULT 0");
  // The metadata sweep's to-do list is "width IS NULL" (see db/enrich.js). It
  // runs once per batch over the whole table, so without this it re-scans 100k+
  // rows on every one of the ~2,000 batches a full sweep takes.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_photos_pending_meta
       ON photos (id) WHERE width IS NULL AND stale = 0`
  );
  ensureFeedIndexes(db);
}

/**
 * Expression indexes for the feed's date grouping/sorting (see sort.js — the DDL
 * is generated there, from the very expressions the queries use).
 *
 * Rebuilds rather than rots: each index name carries a fingerprint of its own
 * definition, so if an expression in sort.js changes, the index built from the
 * OLD expression no longer answers to a wanted name and is dropped here. Without
 * that, a drifted index just stops being used — silently, with no error and no
 * failing test, and the feed slides back to full scans.
 *
 * @param {import("better-sqlite3").Database} db
 */
function ensureFeedIndexes(db) {
  const wanted = feedIndexes();
  const wantedNames = new Set(wanted.map((i) => i.name));

  const existing = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'index' AND name LIKE ?`
    )
    .all(`${FEED_INDEX_PREFIX}%`);

  for (const { name } of existing) {
    if (!wantedNames.has(name)) db.exec(`DROP INDEX IF EXISTS "${name}"`);
  }
  for (const { sql } of wanted) db.exec(sql);
}

/** Idempotent ADD COLUMN — the app ships no migration runner, and
 *  CREATE TABLE IF NOT EXISTS never alters an existing table.
 *
 *  table_xinfo, NOT table_info: `table_info` omits GENERATED columns entirely,
 *  so it reports sort_path as missing on every run after the first, and the
 *  second ALTER dies with "duplicate column name" — i.e. the app would crash on
 *  its second open. `table_xinfo` lists the hidden/generated ones too, and is
 *  identical to `table_info` for ordinary columns. */
function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_xinfo(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
