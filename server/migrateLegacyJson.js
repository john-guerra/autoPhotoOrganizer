import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ratingsFile,
  coverChoicesFile,
  libraryFile,
  cacheRoot,
} from "./lib/cachePaths.js";

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * One-time import of the pre-index JSON stores into the SQLite schema.
 * Guarded so it only ever runs against a fresh (empty) `photos` table —
 * safe to call unconditionally on every startup.
 * @param {import("better-sqlite3").Database} db
 * @returns {{migrated: boolean}}
 */
export function migrateLegacyJsonIfNeeded(db) {
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM photos`).get();
  if (count > 0) return { migrated: false };

  const ratings = readJsonIfExists(ratingsFile()) ?? {};
  const coverChoices = readJsonIfExists(coverChoicesFile()) ?? {};
  const library = readJsonIfExists(libraryFile()) ?? {};
  const metacache = readJsonIfExists(join(cacheRoot(), "metacache.json")) ?? {};

  const upsertFolder = db.prepare(
    `INSERT INTO folders (abs_path, last_scanned_at) VALUES (?, ?)
     ON CONFLICT(abs_path) DO UPDATE SET last_scanned_at = excluded.last_scanned_at`
  );
  const folderIdByPath = new Map();
  for (const [absPath, entry] of Object.entries(library)) {
    upsertFolder.run(absPath, entry.lastScannedAt ?? Date.now());
    const id = db
      .prepare(`SELECT id FROM folders WHERE abs_path = ?`)
      .get(absPath).id;
    folderIdByPath.set(absPath, id);
  }

  const upsertPhotoStub = db.prepare(`
    INSERT INTO photos (folder_id, filename, size, mtime, kind, stale)
    VALUES (@folderId, @filename, 0, 0, 'image', 0)
    ON CONFLICT(folder_id, filename) DO NOTHING
  `);

  function folderIdFor(folderPath) {
    if (folderIdByPath.has(folderPath)) return folderIdByPath.get(folderPath);
    upsertFolder.run(folderPath, Date.now());
    const id = db
      .prepare(`SELECT id FROM folders WHERE abs_path = ?`)
      .get(folderPath).id;
    folderIdByPath.set(folderPath, id);
    return id;
  }

  function photoIdFor(absPath) {
    const folderId = folderIdFor(dirname(absPath));
    const filename = basename(absPath);
    upsertPhotoStub.run({ folderId, filename });
    return db
      .prepare(`SELECT id FROM photos WHERE folder_id = ? AND filename = ?`)
      .get(folderId, filename).id;
  }

  const setRating = db.prepare(`UPDATE photos SET rating = ? WHERE id = ?`);
  for (const [absPath, rating] of Object.entries(ratings)) {
    setRating.run(rating, photoIdFor(absPath));
  }

  const setCover = db.prepare(
    `UPDATE photos SET preferred_cover = 1 WHERE id = ?`
  );
  for (const absPath of Object.keys(coverChoices)) {
    setCover.run(photoIdFor(absPath));
  }

  const setMeta = db.prepare(
    `UPDATE photos SET taken_at = ?, width = ?, height = ? WHERE id = ?`
  );
  for (const [key, entry] of Object.entries(metacache)) {
    // Key is "<absPath> <mtimeMs>" (see metaCache.js's keyFor) — mtimeMs is
    // always the last space-separated token, so dropping it back off is
    // unambiguous even when absPath itself contains spaces.
    const parts = key.split(" ");
    const absPath = parts.slice(0, -1).join(" ");
    if (!absPath) continue;
    const takenAtMs = entry.t ? Date.parse(entry.t) : null;
    setMeta.run(
      takenAtMs,
      entry.w ?? null,
      entry.h ?? null,
      photoIdFor(absPath)
    );
  }

  return { migrated: true };
}
