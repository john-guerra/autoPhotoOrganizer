import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { whenIdle } from "../lib/interactive.js";
import { runSweep } from "../ml/sweep.js";

/** @param {string} path @returns {Promise<string>} */
export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha1");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

let hashingInFlight = false;

/** Photos whose content_hash is still NULL and that have not been written off.
 * Re-queried every batch, so it is the worklist AND the resume point.
 * `idx_photos_content_hash` makes the NULL range an index search, not a scan. */
function pendingHashRows(db, limit) {
  return db
    .prepare(
      `SELECT photos.id, folders.abs_path AS folder_abs_path, photos.filename
         FROM photos JOIN folders ON folders.id = photos.folder_id
        WHERE photos.content_hash IS NULL AND photos.hash_attempted = 0
          AND photos.stale = 0
        LIMIT ?`
    )
    .all(limit);
}

/**
 * Hash the WHOLE library's pending photos in the background, to completion.
 *
 * The drain, idle gating, cancellation, poison-file isolation and — critically —
 * the permanent/transient CLASSIFICATION all live in runSweep now. This file
 * used to hand-roll all of it, and that hand-rolled copy shipped #169: an
 * unmount mid-sweep marked every unreachable file hash_attempted=1, and because
 * upsertScan only clears that when size/mtime CHANGE (which an unmount does
 * not), those photos were excluded from hashing forever.
 *
 * What stays here is the part that is genuinely hashing's own: the worklist
 * query, and the sentinel WRITE. `hash_attempted` keeps exactly its old meaning.
 * A shared sentinel in content_hash is NOT usable — backupCoverage.js and
 * missing.js match files by EQUAL content_hash, so every unreadable file would
 * falsely match every other.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{limit?: number, idle?: () => Promise<void>, job?: object|null, onProgress?: ({done, failed}) => void|null}} [opts]
 * @returns {Promise<{hashed: number, failed: number, paused: boolean, alreadyRunning?: boolean}>}
 */
export async function hashAllPending(
  db,
  { limit = 50, idle = whenIdle, job = null, onProgress = null } = {}
) {
  if (hashingInFlight)
    return { hashed: 0, failed: 0, paused: false, alreadyRunning: true };
  hashingInFlight = true;

  const setHash = db.prepare(`UPDATE photos SET content_hash = ? WHERE id = ?`);
  const markAttempted = db.prepare(
    `UPDATE photos SET hash_attempted = 1 WHERE id = ?`
  );

  try {
    const { done, failed, paused } = await runSweep(job, {
      nextBatch: () => pendingHashRows(db, limit),
      process: async (rows) => {
        let written = 0;
        for (const row of rows) {
          const hash = await hashFile(join(row.folder_abs_path, row.filename));
          setHash.run(hash, row.id);
          written++;
        }
        return written;
      },
      markFailed: (row) => markAttempted.run(row.id),
      folderOf: (row) => row.folder_abs_path,
      onProgress: onProgress ?? undefined,
      idle,
    });
    return { hashed: done - failed, failed, paused };
  } finally {
    hashingInFlight = false;
  }
}

/** Test-only: clear the single-flight latch between cases. */
export function _resetHashingForTest() {
  hashingInFlight = false;
}

/**
 * Compute the progress display counters from raw sweep results.
 * Converts raw {done, failed} from runSweep (where done includes failed rows)
 * into the UI display {done: hashed, phase} (where done excludes failed rows).
 *
 * @param {{done: number, failed: number}} counters
 * @returns {{done: number, phase: string}}
 */
export function hashProgress({ done, failed }) {
  const hashed = done - failed;
  const phase =
    failed > 0
      ? `${hashed.toLocaleString()} hashed · ${failed} unreadable`
      : `${hashed.toLocaleString()} hashed`;
  return { done: hashed, phase };
}
