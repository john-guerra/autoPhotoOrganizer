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
`;

/** @param {import("better-sqlite3").Database} db */
export function applySchema(db) {
  db.exec(SCHEMA_SQL);
  ensureColumn(db, "photos", "btime", "INTEGER");
}

/** Idempotent ADD COLUMN — the app ships no migration runner, and
 *  CREATE TABLE IF NOT EXISTS never alters an existing table. */
function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
