import { join, dirname, basename } from "node:path";
import { volumeRootForPath, upsertVolume } from "./volumes.js";

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} folderAbsPath
 * @param {number} volumeId
 * @param {Array<{name: string, size: number, mtimeMs: number, kind: string}>} files
 * @returns {Array<{id: number, name: string, size: number, mtimeMs: number, rating: number, preferredCover: number}>}
 */
export function upsertScan(db, folderAbsPath, volumeId, files) {
  const now = Date.now();

  db.prepare(
    `INSERT INTO folders (abs_path, volume_id, last_scanned_at)
     VALUES (?, ?, ?)
     ON CONFLICT(abs_path) DO UPDATE SET
       volume_id = excluded.volume_id,
       last_scanned_at = excluded.last_scanned_at`
  ).run(folderAbsPath, volumeId, now);
  const folderId = db
    .prepare(`SELECT id FROM folders WHERE abs_path = ?`)
    .get(folderAbsPath).id;

  const upsertPhoto = db.prepare(`
    INSERT INTO photos (folder_id, filename, size, mtime, btime, kind, stale)
    VALUES (@folderId, @filename, @size, @mtime, @btime, @kind, 0)
    ON CONFLICT(folder_id, filename) DO UPDATE SET
      size = excluded.size,
      mtime = excluded.mtime,
      btime = excluded.btime,
      kind = excluded.kind,
      stale = 0,
      content_hash = CASE
        WHEN photos.size = excluded.size AND photos.mtime = excluded.mtime
        THEN photos.content_hash
        ELSE NULL
      END
  `);
  const markAllStale = db.prepare(
    `UPDATE photos SET stale = 1 WHERE folder_id = ?`
  );

  const tx = db.transaction((files) => {
    markAllStale.run(folderId);
    for (const f of files) {
      upsertPhoto.run({
        folderId,
        filename: f.name,
        size: f.size,
        mtime: f.mtimeMs,
        btime: f.btimeMs ?? null,
        kind: f.kind,
      });
    }
  });
  tx(files);

  return db
    .prepare(
      `SELECT id, filename AS name, size, mtime AS mtimeMs, rating,
              preferred_cover AS preferredCover
       FROM photos WHERE folder_id = ? AND stale = 0 ORDER BY filename`
    )
    .all(folderId);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {number} id
 */
export function getPhotoById(db, id) {
  const row = db
    .prepare(
      `SELECT photos.*, folders.abs_path AS folder_abs_path
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.id = ?`
    )
    .get(id);
  if (!row) return undefined;
  return { ...row, path: join(row.folder_abs_path, row.filename) };
}

/** @param {import("better-sqlite3").Database} db @param {number} id @param {number} rating */
export function setPhotoRating(db, id, rating) {
  db.prepare(`UPDATE photos SET rating = ? WHERE id = ?`).run(rating, id);
}

/** @param {import("better-sqlite3").Database} db @param {number} id @param {boolean} isCover */
export function setPhotoCover(db, id, isCover) {
  db.prepare(`UPDATE photos SET preferred_cover = ? WHERE id = ?`).run(
    isCover ? 1 : 0,
    id
  );
}

/**
 * Ensure a `folders` row exists for `absPath`, using the same
 * insert-or-update shape `upsertScan` uses for the folders table (so a
 * moved-into directory becomes a normal, browsable scanned folder). Does NOT
 * touch `photos` rows for that folder — unlike `upsertScan`, which would
 * mark every other photo in the destination folder stale if called with a
 * single-file list.
 * @param {import("better-sqlite3").Database} db
 * @param {string} absPath
 * @param {number} volumeId
 * @returns {number} the folder's id
 */
function ensureFolderRow(db, absPath, volumeId) {
  db.prepare(
    `INSERT INTO folders (abs_path, volume_id, last_scanned_at)
     VALUES (?, ?, ?)
     ON CONFLICT(abs_path) DO UPDATE SET
       volume_id = excluded.volume_id`
  ).run(absPath, volumeId, Date.now());
  return db.prepare(`SELECT id FROM folders WHERE abs_path = ?`).get(absPath)
    .id;
}

/**
 * Repoint a photo's index row to a new absolute path after it has been
 * MOVED on disk (e.g. materialize-with-move into an album folder). Ensures a
 * `folders` row exists for the destination directory — via the same
 * folder-upsert shape the scanner uses, so the destination becomes a normal
 * browsable section — then updates the photo's `folder_id` + `filename` so
 * `getPhotoById(db, id).path` reflects the new location and the photo is no
 * longer reported "missing". The source folder row is left untouched.
 * @param {import("better-sqlite3").Database} db
 * @param {number} id
 * @param {string} newAbsPath
 */
export function repointPhoto(db, id, newAbsPath) {
  const dir = dirname(newAbsPath);
  const filename = basename(newAbsPath);
  const volumeId = upsertVolume(db, volumeRootForPath(dir));
  const folderId = ensureFolderRow(db, dir, volumeId);
  db.prepare(`UPDATE photos SET folder_id = ?, filename = ? WHERE id = ?`).run(
    folderId,
    filename,
    id
  );
}

/**
 * Remove a folder and its photos from the index. Real files on disk are
 * never touched — this only affects the `folders`/`photos` rows.
 * photo_album/tags aren't cleaned up here: album clustering (GH #3) isn't
 * implemented yet and those tables have no rows today.
 * @param {import("better-sqlite3").Database} db
 * @param {number} folderId
 * @returns {boolean} true if the folder existed and was removed
 */
export function deleteFolder(db, folderId) {
  const tx = db.transaction((id) => {
    const exists = db.prepare(`SELECT id FROM folders WHERE id = ?`).get(id);
    if (!exists) return false;
    db.prepare(`DELETE FROM photos WHERE folder_id = ?`).run(id);
    db.prepare(`DELETE FROM folders WHERE id = ?`).run(id);
    return true;
  });
  return tx(folderId);
}

/**
 * Wipe the entire index — every scanned folder, photo, album, tag, and known
 * volume — in one transaction. This is the "start over" nuclear option (see
 * POST /api/library/reset); real files on disk are never touched, only the
 * SQLite rows that mirror them. Deletion order (children before parents)
 * doesn't matter today since foreign_keys enforcement isn't turned on, but
 * is kept anyway so this stays correct if that ever changes.
 * @param {import("better-sqlite3").Database} db
 * @returns {{folders: number, photos: number}} row counts as of just before
 *   the delete.
 */
export function resetLibrary(db) {
  const tx = db.transaction(() => {
    const folders = db.prepare(`SELECT COUNT(*) AS c FROM folders`).get().c;
    const photos = db.prepare(`SELECT COUNT(*) AS c FROM photos`).get().c;
    db.prepare(`DELETE FROM photo_tags`).run();
    db.prepare(`DELETE FROM tags`).run();
    db.prepare(`DELETE FROM photo_album`).run();
    db.prepare(`DELETE FROM albums`).run();
    db.prepare(`DELETE FROM photos`).run();
    db.prepare(`DELETE FROM folders`).run();
    db.prepare(`DELETE FROM volumes`).run();
    return { folders, photos };
  });
  return tx();
}
