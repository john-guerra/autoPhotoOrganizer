import { join, dirname, basename, sep } from "node:path";
import { volumeRootForPath, upsertVolume } from "./volumes.js";
import { normalizeFolderPath } from "../lib/normalizeFolderPath.js";
import { clearEmbeddingsFor } from "./embeddings.js";

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} folderAbsPath
 * @param {number} volumeId
 * @param {Array<{name: string, size: number, mtimeMs: number, kind: string}>} files
 * @returns {Array<{id: number, name: string, size: number, mtimeMs: number, rating: number, preferredCover: number}>}
 */
export function upsertScan(db, folderAbsPath, volumeId, files) {
  // Identity is the exact abs_path string (UNIQUE + ON CONFLICT below), so a
  // trailing separator would fork the same folder into two rows — see #138.
  folderAbsPath = normalizeFolderPath(folderAbsPath);
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
    INSERT INTO photos (folder_id, filename, size, mtime, btime, kind, stale, first_seen_at)
    VALUES (@folderId, @filename, @size, @mtime, @btime, @kind, 0, @now)
    ON CONFLICT(folder_id, filename) DO UPDATE SET
      size = excluded.size,
      mtime = excluded.mtime,
      btime = excluded.btime,
      kind = excluded.kind,
      stale = 0,
      dismissed = 0,
      content_hash = CASE
        WHEN photos.size = excluded.size AND photos.mtime = excluded.mtime
        THEN photos.content_hash
        ELSE NULL
      END,
      -- A changed file (new size/mtime) must be re-hashed: null the hash AND
      -- clear the attempted marker, or a file that once failed to hash (or whose
      -- bytes changed) would stay excluded from the sweep forever.
      hash_attempted = CASE
        WHEN photos.size = excluded.size AND photos.mtime = excluded.mtime
        THEN photos.hash_attempted
        ELSE 0
      END
      ,
      -- A changed file may have been re-exported with different (or stripped)
      -- GPS, so clear the "we looked" marker and let the sweep look again.
      gps_checked = CASE
        WHEN photos.size = excluded.size AND photos.mtime = excluded.mtime
        THEN photos.gps_checked
        ELSE 0
      END
  `);
  const markAllStale = db.prepare(
    `UPDATE photos SET stale = 1 WHERE folder_id = ?`
  );

  // Which photos' BYTES changed this scan. The ON CONFLICT clause above can
  // express "keep or null a column", but embeddings live in their own table, so
  // dropping them needs the id list — and it has to be captured BEFORE the
  // upsert overwrites the old size/mtime we compare against.
  const priorByName = new Map(
    db
      .prepare(
        `SELECT id, filename, size, mtime FROM photos WHERE folder_id = ?`
      )
      .all(folderId)
      .map((r) => [r.filename, r])
  );

  const tx = db.transaction((files) => {
    markAllStale.run(folderId);
    const changedIds = [];
    for (const f of files) {
      const prior = priorByName.get(f.name);
      if (prior && (prior.size !== f.size || prior.mtime !== f.mtimeMs)) {
        changedIds.push(prior.id);
      }
      upsertPhoto.run({
        folderId,
        filename: f.name,
        size: f.size,
        mtime: f.mtimeMs,
        btime: f.btimeMs ?? null,
        kind: f.kind,
        now,
      });
    }
    // An edited photo that keeps its old vector is wrong FOREVER — the worklist
    // only asks whether a vector exists, never whether it still describes the
    // current bytes. Same reasoning as content_hash above; different table, so
    // it cannot ride the ON CONFLICT CASE.
    clearEmbeddingsFor(db, changedIds);
  });
  tx(files);

  return db
    .prepare(
      `SELECT id, filename AS name, size, mtime AS mtimeMs, rating,
              preferred_cover AS preferredCover, kind, duration,
              no_auto_stack AS keepSeparate,
              (SELECT group_id FROM manual_stacks WHERE photo_id = photos.id) AS manualStackId
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
  const folderId = resolveDestFolderId(db, dir);
  repointPhotoToFolder(db, id, folderId, basename(newAbsPath));
}

/**
 * Resolve (creating if needed) the `folders` row id for a destination
 * directory. This is the EXPENSIVE part of a repoint: `upsertVolume` shells out
 * to `diskutil` to identify the volume. When repointing many photos into the
 * SAME directory (e.g. every photo of an album move), resolve it ONCE with this
 * and repoint each row with the cheap `repointPhotoToFolder` — calling
 * `repointPhoto` per file instead spawns `diskutil` per file and turns a fast
 * same-volume move into a multi-minute crawl.
 * @param {import("better-sqlite3").Database} db
 * @param {string} dirAbsPath
 * @returns {number} folder id
 */
export function resolveDestFolderId(db, dirAbsPath) {
  const volumeId = upsertVolume(db, volumeRootForPath(dirAbsPath));
  return ensureFolderRow(db, dirAbsPath, volumeId);
}

/**
 * Cheap per-photo repoint: just re-parent the row to an already-resolved folder
 * id (see `resolveDestFolderId`). No volume/folder resolution, no subprocess.
 * @param {import("better-sqlite3").Database} db
 * @param {number} id
 * @param {number} folderId
 * @param {string} filename
 */
export function repointPhotoToFolder(db, id, folderId, filename) {
  db.prepare(`UPDATE photos SET folder_id = ?, filename = ? WHERE id = ?`).run(
    folderId,
    filename,
    id
  );
}

/**
 * Repoint the index after a folder has been RENAMED on disk (issue #68 Slice B).
 * Updates the folder's own `abs_path` row AND every scanned descendant folder
 * (its `abs_path` starts with `oldAbsPath/`), replacing the path prefix. Photo
 * rows need no change — a photo's path derives from its `folder_id` + filename,
 * so once the folder rows point at the new location, `getPhotoById().path` is
 * correct. The caller is responsible for the on-disk `renameSync` first.
 *
 * Folder counts are small (tens), so this scans all rows in JS rather than a
 * LIKE query — no metacharacter escaping to get wrong.
 * @param {import("better-sqlite3").Database} db
 * @param {string} oldAbsPath
 * @param {string} newAbsPath
 */
export function renameFolderPath(db, oldAbsPath, newAbsPath) {
  const oldPrefix = oldAbsPath.endsWith(sep) ? oldAbsPath : oldAbsPath + sep;
  const newPrefix = newAbsPath.endsWith(sep) ? newAbsPath : newAbsPath + sep;
  const update = db.prepare(`UPDATE folders SET abs_path = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const row of db.prepare(`SELECT id, abs_path FROM folders`).all()) {
      if (row.abs_path === oldAbsPath) update.run(newAbsPath, row.id);
      else if (row.abs_path.startsWith(oldPrefix)) {
        update.run(newPrefix + row.abs_path.slice(oldPrefix.length), row.id);
      }
    }
  });
  tx();
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
 * Remove a folder AND its whole subtree from the index by absolute path — the
 * folder itself (if it has its own row) plus every descendant folder and all
 * their photos. Real files on disk are never touched.
 *
 * "Remove from library" on a PARENT has to mean the subtree, or it silently does
 * nothing: `deleteFolder` drops one folder's own row, but the children stay
 * indexed and the parent is immediately reconstructed from them, so the user sees
 * no change. It also has to work for a pure ANCESTOR that has no `folders` row of
 * its own (it only contains sub-folders) — the prefix match still finds its
 * descendants.
 *
 * Matches by scanning the folder rows in JS, exactly as `renameFolderPath` does
 * and for the same reason: folder counts are small (tens), and folder names here
 * are full of `_` (`2025_11Nov_08`) — a LIKE wildcard — so a SQL prefix match
 * would need metacharacter escaping that is easy to get wrong. A trailing-`sep`
 * prefix also keeps `…Canon 1` from matching its sibling `…Canon 10`.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} absPath  the folder's absolute path
 * @returns {{folders: number, photos: number}} rows removed (folders 0 = nothing
 *   matched, neither the folder nor any descendant — the caller reports 404)
 */
export function deleteFolderSubtree(db, absPath) {
  const prefix = absPath.endsWith(sep) ? absPath : absPath + sep;
  const tx = db.transaction(() => {
    const ids = db
      .prepare(`SELECT id, abs_path FROM folders`)
      .all()
      .filter((r) => r.abs_path === absPath || r.abs_path.startsWith(prefix))
      .map((r) => r.id);
    if (!ids.length) return { folders: 0, photos: 0 };
    const placeholders = ids.map(() => "?").join(",");
    const photos = db
      .prepare(`DELETE FROM photos WHERE folder_id IN (${placeholders})`)
      .run(...ids).changes;
    const folders = db
      .prepare(`DELETE FROM folders WHERE id IN (${placeholders})`)
      .run(...ids).changes;
    return { folders, photos };
  });
  return tx();
}

/**
 * Remove specific photos from the index by id — the by-selection / by-group
 * companion to deleteFolderSubtree (which removes by folder). Used to drop
 * everything under a non-folder group header (a year, a camera, a day), where
 * there's no folder to delete. Files on disk are NEVER touched; only the SQLite
 * rows. The removed photos' tag/album junction rows go too, and any folder these
 * photos emptied is pruned so it doesn't linger in the tree.
 * @param {import("better-sqlite3").Database} db
 * @param {number[]} ids
 * @returns {{photos:number, folders:number}} rows actually deleted
 */
export function deletePhotosByIds(db, ids) {
  const clean = [...new Set((ids ?? []).map(Number).filter(Number.isInteger))];
  if (!clean.length) return { photos: 0, folders: 0 };
  const ph = clean.map(() => "?").join(",");
  const tx = db.transaction(() => {
    // Folders holding at least one doomed photo — candidates to prune once the
    // photos are gone. Captured BEFORE the delete, while the rows still exist.
    const affected = db
      .prepare(
        `SELECT DISTINCT folder_id AS id FROM photos WHERE id IN (${ph})`
      )
      .all(...clean)
      .map((r) => r.id);
    db.prepare(`DELETE FROM photo_tags WHERE photo_id IN (${ph})`).run(
      ...clean
    );
    db.prepare(`DELETE FROM photo_album WHERE photo_id IN (${ph})`).run(
      ...clean
    );
    const photos = db
      .prepare(`DELETE FROM photos WHERE id IN (${ph})`)
      .run(...clean).changes;
    let folders = 0;
    if (affected.length) {
      const aph = affected.map(() => "?").join(",");
      folders = db
        .prepare(
          `DELETE FROM folders WHERE id IN (${aph})
             AND id NOT IN (SELECT DISTINCT folder_id FROM photos)`
        )
        .run(...affected).changes;
    }
    return { photos, folders };
  });
  return tx();
}

/**
 * Wipe the entire index — every scanned folder, photo, album, tag, and known
 * volume — in one transaction. This is the "start over" nuclear option (see
 * POST /api/library/reset); real files on disk are never touched, only the
 * SQLite rows that mirror them. Deletion order (children before parents)
 * DOES matter: better-sqlite3 enables `PRAGMA foreign_keys` by default (unlike
 * raw SQLite, which is off unless a caller turns it on), so a parent row with
 * a surviving child throws rather than silently orphaning it. photo_embeddings
 * and ml_status (#161) are declared ON DELETE CASCADE for exactly this reason
 * — see server/db/schema.js — but any table without a CASCADE FK must still be
 * emptied before its parent.
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
