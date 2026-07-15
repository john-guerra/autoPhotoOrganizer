import { join, basename } from "node:path";
import { resolveDestFolderId, repointPhotoToFolder } from "./photos.js";

/**
 * Every OTHER photo row representing the same underlying file as `row`:
 * identical non-null content_hash, or identical (filename, size, mtime) — the
 * triple a Finder move or a byte-for-byte backup copy preserves. Ordered by id.
 * @param {import("better-sqlite3").Database} db
 * @param {{id:number, content_hash:?string, filename:string, size:number, mtime:number}} row
 * @returns {Array<{id:number, folderId:number, absPath:string, volumeId:?number, stale:number, dismissed:number, firstSeenAt:?number}>}
 */
export function sameFileCandidates(db, row) {
  return db
    .prepare(
      `SELECT photos.id AS id, folders.id AS folderId,
              folders.abs_path AS absPath, folders.volume_id AS volumeId,
              photos.stale AS stale, photos.dismissed AS dismissed,
              photos.first_seen_at AS firstSeenAt
         FROM photos JOIN folders ON folders.id = photos.folder_id
        WHERE photos.id != @id
          AND (
            (@hash IS NOT NULL AND photos.content_hash = @hash)
            OR (photos.filename = @filename AND photos.size = @size AND photos.mtime = @mtime)
          )
        ORDER BY photos.id`
    )
    .all({
      id: row.id,
      hash: row.content_hash ?? null,
      filename: row.filename,
      size: row.size,
      mtime: row.mtime,
    });
}
