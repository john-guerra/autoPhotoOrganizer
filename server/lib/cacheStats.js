import { createHash } from "node:crypto";
import { existsSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { thumbsDir } from "./cachePaths.js";

// Every thumbnail size the client ever requests (ui/src/App.svelte snaps
// the displayed size to one of these five, specifically so the disk cache
// doesn't fragment per pixel) — the complete, exhaustive set to check.
const THUMB_BUCKETS = [160, 320, 480, 640, 1024];

/**
 * The exact cache-key formula from GET /api/thumb/:id (server/api.js) —
 * kept in sync manually since duplicating a one-line hash call is simpler
 * than adding a shared-module indirection for a single expression.
 * @param {{path:string, mtime:number, size:number}} photo
 * @param {number} bucket
 * @returns {string} sha1 hex key
 */
function cacheKeyFor(photo, bucket) {
  return createHash("sha1")
    .update(`${photo.path}:${photo.mtime}:${photo.size}:${bucket}`)
    .digest("hex");
}

/**
 * @param {{path:string, mtime:number, size:number}} photo
 * @returns {string[]} the cache key for every bucket this photo could have
 */
function expectedCacheKeys(photo) {
  return THUMB_BUCKETS.map((bucket) => cacheKeyFor(photo, bucket));
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
export function getCacheBreakdown(db) {
  const rows = db
    .prepare(
      `SELECT photos.filename, photos.size, photos.mtime,
              folders.id AS folderId, folders.abs_path AS folderPath
       FROM photos JOIN folders ON folders.id = photos.folder_id`
    )
    .all();

  const dir = thumbsDir();
  const byFolder = new Map();
  for (const r of rows) {
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
      const cachePath = join(dir, `${key}.jpg`);
      if (existsSync(cachePath)) {
        entry.cachedBytes += statSync(cachePath).size;
        entry.cachedFiles += 1;
      }
    }
  }
  return { folders: [...byFolder.values()] };
}

/** @returns {{freedBytes:number, freedFiles:number}} */
export function clearCache() {
  const dir = thumbsDir();
  const files = readdirSync(dir);
  let freedBytes = 0;
  for (const f of files) {
    const p = join(dir, f);
    freedBytes += statSync(p).size;
    unlinkSync(p);
  }
  return { freedBytes, freedFiles: files.length };
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
