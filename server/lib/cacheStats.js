import { existsSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { thumbsDir, thumbCacheKey, THUMB_BUCKETS } from "./cachePaths.js";
import { whenIdle } from "./interactive.js";

/**
 * @param {{path:string, mtime:number, size:number}} photo
 * @returns {string[]} the bare cache key for every bucket this photo could have
 */
function expectedCacheKeys(photo) {
  return THUMB_BUCKETS.map((bucket) => thumbCacheKey(photo, bucket));
}

/** @returns {{totalBytes:number, totalFiles:number}} */
export function getCacheStats() {
  const dir = thumbsDir();
  const files = readdirSync(dir);
  let totalBytes = 0;
  for (const f of files) {
    totalBytes += statSync(join(dir, f)).size;
  }
  return { totalBytes, totalFiles: files.length };
}

/**
 * Attributes cached thumbnail bytes to the folder each source photo lives
 * in. The flat, content-hash-keyed cache has no stored folder association,
 * so this recomputes each indexed photo's possible cache keys (one per
 * THUMB_BUCKETS entry) and checks which exist on disk — the only way to
 * attribute usage given the current cache design.
 * @param {import("better-sqlite3").Database} db
 * @returns {{folders: Array<{id:number, path:string, cachedBytes:number, cachedFiles:number}>}}
 */
export async function getCacheBreakdown(db) {
  const rows = db
    .prepare(
      `SELECT photos.filename, photos.size, photos.mtime,
              folders.id AS folderId, folders.abs_path AS folderPath
       FROM photos JOIN folders ON folders.id = photos.folder_id`
    )
    .all();

  // Read the cache directory ONCE, into key -> bytes.
  //
  // The old shape asked the filesystem a question per photo per bucket:
  // existsSync + statSync, 5 buckets x every indexed photo. On a 123k-photo
  // library that is ~615,000 synchronous syscalls ON THE EVENT LOOP — measured
  // at 2.0s for the breakdown itself, during which an ordinary feed page went
  // from ~1ms to 1.81s. Opening "Manage library" wedged the whole server.
  //
  // Statting the cache directory instead is bounded by how many thumbnails
  // EXIST (~16k), not by photos x buckets, and every lookup below is then a
  // Map hit. Same numbers, one pass.
  const sizeByKey = cacheFileSizes();

  const byFolder = new Map();
  // Yield the event loop every CHUNK rows. better-sqlite3 is synchronous, so a
  // 114k-row attribution pass still holds the loop for ~0.4s even with the
  // syscalls gone — and while it does, every thumbnail and feed page in flight
  // waits behind it. Breathing between chunks costs nothing and keeps the app
  // answering (CLAUDE.md: heavy IO belongs off the main event loop).
  const CHUNK = 5000;
  let seen = 0;
  for (const r of rows) {
    if (++seen % CHUNK === 0) await new Promise(setImmediate);
    const photo = {
      path: join(r.folderPath, r.filename),
      mtime: r.mtime,
      size: r.size,
    };
    let entry = byFolder.get(r.folderId);
    if (!entry) {
      entry = {
        id: r.folderId,
        path: r.folderPath,
        cachedBytes: 0,
        cachedFiles: 0,
      };
      byFolder.set(r.folderId, entry);
    }
    for (const key of expectedCacheKeys(photo)) {
      const bytes = sizeByKey.get(key);
      if (bytes !== undefined) {
        entry.cachedBytes += bytes;
        entry.cachedFiles += 1;
      }
    }
  }
  return { folders: [...byFolder.values()] };
}

/** Every cached thumbnail's key -> its size in bytes, in one directory pass.
 *  @returns {Map<string, number>} */
function cacheFileSizes() {
  const dir = thumbsDir();
  const sizeByKey = new Map();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jpg")) continue;
    try {
      sizeByKey.set(f.slice(0, -".jpg".length), statSync(join(dir, f)).size);
    } catch {
      // Raced with a prune/clear — a file that vanished mid-pass simply isn't
      // cached any more, which is exactly what an absent key means here.
    }
  }
  return sizeByKey;
}

/**
 * How many thumbnails are cached, without stating a single one.
 *
 * `getCacheStats` also returns this, but it `statSync`s every file to total the
 * bytes — on a real cache that is hundreds of thousands of syscalls, which is
 * the very thing #281 was about. A caller that only needs a job's `total`
 * wants the directory listing and nothing else.
 * @returns {number}
 */
export function countCachedThumbnails() {
  try {
    return readdirSync(thumbsDir()).length;
  } catch {
    return 0;
  }
}

/**
 * Empty the thumbnail cache, in batches, without wedging the server.
 *
 * MEASURED (`docs/ARCHITECTURE-REVIEW-2026-08-04.md` §2): the synchronous
 * version this replaces took **8.42 s** for 125,000 files — two syscalls each,
 * none of them yielding — and a real library holds roughly five of these per
 * photo (`THUMB_BUCKETS`), so the felt cost was closer to 42 s. For all of it
 * the server answered nothing: no thumbnails, no feed, not even `/api/health`.
 * That is what John saw as "nothing happened" followed by
 * "Lost the connection to the AutoGallery server" (#281) — the reset had not
 * failed, it had eaten the event loop, and the client's 4 s health timeout
 * concluded the process was dead.
 *
 * `statSync`/`unlinkSync` stay synchronous on purpose: an individual syscall is
 * microseconds, and the async variants would cost a promise per file for no
 * latency gain. What was missing is a yield BETWEEN batches, which is the
 * difference between 8 s of deafness and 8 s of a responsive app doing work.
 *
 * @param {{batch?: number, onProgress?: (p: {done: number, total: number}) => void,
 *          signal?: AbortSignal, idle?: () => Promise<void>}} [opts]
 * @returns {Promise<{freedBytes:number, freedFiles:number, canceled:boolean}>}
 */
export async function clearCache({
  batch = 500,
  onProgress,
  signal,
  idle = whenIdle,
} = {}) {
  const dir = thumbsDir();
  const files = readdirSync(dir);
  let freedBytes = 0;
  let done = 0;
  for (const f of files) {
    if (signal?.aborted) {
      // Half a cache is a perfectly good cache — every missing thumbnail is
      // simply regenerated on demand. So stopping costs nothing but time.
      return { freedBytes, freedFiles: done, canceled: true };
    }
    const p = join(dir, f);
    try {
      freedBytes += statSync(p).size;
      unlinkSync(p);
    } catch {
      // Raced with a prune, or a thumbnail written and removed mid-pass.
    }
    done += 1;
    if (done % batch === 0) {
      await idle();
      onProgress?.({ done, total: files.length });
    }
  }
  onProgress?.({ done, total: files.length });
  return { freedBytes, freedFiles: done, canceled: false };
}

/**
 * Deletes cache files with no corresponding indexed photo (orphans left
 * behind by a removed photo/folder, or a stale entry whose source file
 * changed on disk before a rescan). Never touches a source folder.
 * @param {import("better-sqlite3").Database} db
 * @returns {{freedBytes:number, freedFiles:number}}
 */
export function pruneOrphanedCache(db) {
  const rows = db
    .prepare(
      `SELECT photos.filename, photos.size, photos.mtime, folders.abs_path AS folderPath
       FROM photos JOIN folders ON folders.id = photos.folder_id`
    )
    .all();

  const expected = new Set();
  for (const r of rows) {
    const photo = {
      path: join(r.folderPath, r.filename),
      mtime: r.mtime,
      size: r.size,
    };
    for (const key of expectedCacheKeys(photo)) expected.add(key);
  }

  const dir = thumbsDir();
  const files = readdirSync(dir);
  let freedBytes = 0;
  let freedFiles = 0;
  for (const f of files) {
    const key = f.endsWith(".jpg") ? f.slice(0, -4) : f;
    if (!expected.has(key)) {
      const p = join(dir, f);
      freedBytes += statSync(p).size;
      unlinkSync(p);
      freedFiles += 1;
    }
  }
  return { freedBytes, freedFiles };
}
