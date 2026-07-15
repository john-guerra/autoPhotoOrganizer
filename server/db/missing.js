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

/**
 * Repoint a vanished (stale) row to where its file now lives, keeping the row id
 * so every FK (albums/tags/keep_scope/manual_stacks) and on-row field (rating,
 * preferred_cover, no_auto_stack) survives. Deletes any freshly-scanned
 * duplicate already occupying the destination's (folder, filename) slot first.
 * @param {import("better-sqlite3").Database} db
 * @param {number} staleId
 * @param {string} destAbsPath  absolute path of the file at its new location
 * @returns {{relocatedId:number}}
 */
export function relocateMissing(db, staleId, destAbsPath) {
  const destFolderId = resolveDestFolderId(db, join(destAbsPath, "..")); // dir
  const filename = basename(destAbsPath);
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM photos WHERE folder_id = ? AND filename = ? AND id != ?`
    ).run(destFolderId, filename, staleId);
    repointPhotoToFolder(db, staleId, destFolderId, filename);
    db.prepare(`UPDATE photos SET stale = 0, dismissed = 0 WHERE id = ?`).run(
      staleId
    );
  });
  tx();
  return { relocatedId: staleId };
}

/**
 * Classify a single stale row. `moved` is the only kind eligible for silent
 * auto-relocate, and only when it is unambiguous and no other copy survives.
 * @param {import("better-sqlite3").Database} db
 * @param {{id:number, content_hash:?string, filename:string, size:number, mtime:number, firstSeenAt:?number}} staleRow
 * @param {number} scanStartedAt  ms; a candidate is "new this scan" if firstSeenAt >= this
 * @returns {{kind:"moved"|"covered"|"gone"|"ambiguous", moveTargetAbsPath?:string, survivors:Array<{id:number, absPath:string, volumeId:?number}>}}
 */
export function classifyRow(db, staleRow, scanStartedAt) {
  const cands = sameFileCandidates(db, staleRow);
  const survivors = cands
    .filter((c) => c.stale === 0 && c.dismissed === 0)
    .map((c) => ({ id: c.id, absPath: c.absPath, volumeId: c.volumeId }));
  const newThisScan = cands.filter(
    (c) =>
      c.stale === 0 &&
      c.dismissed === 0 &&
      (c.firstSeenAt ?? 0) >= scanStartedAt
  );
  const preExisting = survivors.filter(
    (s) => !newThisScan.some((n) => n.id === s.id)
  );
  if (newThisScan.length === 1 && preExisting.length === 0) {
    return {
      kind: "moved",
      moveTargetAbsPath: join(newThisScan[0].absPath, staleRow.filename),
      survivors,
    };
  }
  if (preExisting.length > 0) return { kind: "covered", survivors };
  if (newThisScan.length > 1) return { kind: "ambiguous", survivors };
  return { kind: "gone", survivors };
}

/**
 * Walk every unresolved missing row; auto-relocate clean moves; count the rest.
 * @param {import("better-sqlite3").Database} db
 * @param {number} scanStartedAt
 * @returns {{autoRelocated:number, toReview:number}}
 */
export function classifyMissing(db, scanStartedAt) {
  const stale = db
    .prepare(
      `SELECT id, content_hash, filename, size, mtime, first_seen_at AS firstSeenAt
         FROM photos WHERE stale = 1 AND dismissed = 0`
    )
    .all();
  let autoRelocated = 0;
  let toReview = 0;
  for (const row of stale) {
    const c = classifyRow(db, row, scanStartedAt);
    if (c.kind === "moved") {
      relocateMissing(db, row.id, c.moveTargetAbsPath);
      autoRelocated += 1;
    } else {
      toReview += 1;
    }
  }
  return { autoRelocated, toReview };
}
