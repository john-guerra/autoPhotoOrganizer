import { join } from "node:path";

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
    INSERT INTO photos (folder_id, filename, size, mtime, kind, stale)
    VALUES (@folderId, @filename, @size, @mtime, @kind, 0)
    ON CONFLICT(folder_id, filename) DO UPDATE SET
      size = excluded.size,
      mtime = excluded.mtime,
      kind = excluded.kind,
      stale = 0,
      content_hash = CASE
        WHEN photos.size = excluded.size AND photos.mtime = excluded.mtime
        THEN photos.content_hash
        ELSE NULL
      END
  `);
  const markAllStale = db.prepare(`UPDATE photos SET stale = 1 WHERE folder_id = ?`);

  const tx = db.transaction((files) => {
    markAllStale.run(folderId);
    for (const f of files) {
      upsertPhoto.run({
        folderId,
        filename: f.name,
        size: f.size,
        mtime: f.mtimeMs,
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
