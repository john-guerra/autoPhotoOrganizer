/**
 * @param {import("better-sqlite3").Database} db
 * @param {number} photoId
 * @returns {{volumeIds: number[]}}
 */
export function getBackupCoverage(db, photoId) {
  const photo = db
    .prepare(`SELECT content_hash FROM photos WHERE id = ?`)
    .get(photoId);
  if (!photo || !photo.content_hash) return { volumeIds: [] };

  const rows = db
    .prepare(
      `SELECT DISTINCT folders.volume_id AS volumeId
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.content_hash = ? AND photos.stale = 0`
    )
    .all(photo.content_hash);
  return { volumeIds: rows.map((r) => r.volumeId).filter((v) => v != null) };
}

/**
 * Photos on `volumeId` whose content hash has no match on any other volume.
 * @param {import("better-sqlite3").Database} db
 * @param {number} volumeId
 * @returns {Array<{id: number, filename: string, folder_abs_path: string}>}
 */
export function getUnbackedUpPhotos(db, volumeId) {
  return db
    .prepare(
      `SELECT photos.id, photos.filename, folders.abs_path AS folder_abs_path
       FROM photos
       JOIN folders ON folders.id = photos.folder_id
       WHERE folders.volume_id = ? AND photos.stale = 0
         AND photos.content_hash IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM photos p2
           JOIN folders f2 ON f2.id = p2.folder_id
           WHERE p2.content_hash = photos.content_hash
             AND f2.volume_id != ?
             AND p2.stale = 0
         )`
    )
    .all(volumeId, volumeId);
}
