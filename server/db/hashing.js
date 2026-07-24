import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { whenIdle } from "../lib/interactive.js";

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

/**
 * Hash one batch of photos whose content_hash is still NULL. Never blocks a
 * scan's grid paint — callers invoke this after already responding.
 *
 * An unreadable file is marked `hash_attempted = 1` (its content_hash stays NULL
 * — it simply has no signature) so the background driver below can't re-select
 * the same failing rows forever. This mirrors the metadata sweep's width-0
 * "attempted" marker. A shared sentinel in content_hash is NOT usable here:
 * backupCoverage.js and missing.js match files by EQUAL content_hash, so every
 * unreadable file would falsely match every other.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{hashed: number, failed: number, remaining: boolean}>}
 */
export async function hashPendingPhotos(db, { limit = 50 } = {}) {
  const rows = db
    .prepare(
      `SELECT photos.id, folders.abs_path AS folder_abs_path, photos.filename
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.content_hash IS NULL AND photos.hash_attempted = 0
         AND photos.stale = 0
       LIMIT ?`
    )
    .all(limit);

  const setHash = db.prepare(`UPDATE photos SET content_hash = ? WHERE id = ?`);
  const markAttempted = db.prepare(
    `UPDATE photos SET hash_attempted = 1 WHERE id = ?`
  );
  let hashed = 0;
  let failed = 0;
  for (const row of rows) {
    const path = join(row.folder_abs_path, row.filename);
    try {
      const hash = await hashFile(path);
      setHash.run(hash, row.id);
      hashed++;
    } catch {
      // Unreadable file: mark attempted so the sweep makes progress. Hashing
      // failure must never block culling on an otherwise-usable photo.
      markAttempted.run(row.id);
      failed++;
    }
  }
  return { hashed, failed, remaining: rows.length === limit };
}

let hashingInFlight = false;

/**
 * Hash the WHOLE library's pending photos in the background, to completion.
 *
 * - **Idle-gated**: between batches it `await idle()` (see lib/interactive.js) so
 *   it never competes with the user's scroll — the sweep uses what's left after
 *   the interactive thumbnail requests are served.
 * - **Single-flight**: a second call while one is running is a no-op. The running
 *   loop re-queries the NULL set each batch, so it naturally picks up rows a
 *   concurrent scan just added — no need to start a second driver.
 * - **Guaranteed to terminate**: every row is either hashed or marked
 *   hash_attempted, so the pending set strictly shrinks each batch.
 *
 * Fire-and-forget from callers (`.catch(() => {})`): it never blocks a response.
 * Completing the whole library (not the ~50 rows the old single-batch call left
 * hashed) is what makes backup-coverage/dedup (#12/#86) real. Because the pending
 * query spans the whole `photos` table, the next scan of ANY folder finishes the
 * entire backlog.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{limit?: number, idle?: () => Promise<void>}} [opts]
 * @returns {Promise<{hashed: number, failed: number, alreadyRunning?: boolean}>}
 */
export async function hashAllPending(db, { limit = 50, idle = whenIdle } = {}) {
  if (hashingInFlight) return { hashed: 0, failed: 0, alreadyRunning: true };
  hashingInFlight = true;
  let hashed = 0;
  let failed = 0;
  try {
    for (;;) {
      await idle();
      const batch = await hashPendingPhotos(db, { limit });
      hashed += batch.hashed;
      failed += batch.failed;
      if (!batch.remaining) break;
    }
  } finally {
    hashingInFlight = false;
  }
  return { hashed, failed };
}

/** Test-only: clear the single-flight latch between cases. */
export function _resetHashingForTest() {
  hashingInFlight = false;
}
