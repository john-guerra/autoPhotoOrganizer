import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

/**
 * Resolve the AutoGallery cache root on the INTERNAL disk.
 *
 * ALL writes this app makes land under here (~/.autogallery). Scanned photo
 * folders are strictly read-only; nothing is ever written back to them.
 *
 * Overridable via AUTOGALLERY_HOME so tests can point at a temp dir.
 * @returns {string} Absolute path to the cache root.
 */
export function cacheRoot() {
  return process.env.AUTOGALLERY_HOME || join(homedir(), ".autogallery");
}

/** @returns {string} Absolute path to the thumbnail cache dir (created if missing). */
export function thumbsDir() {
  const dir = join(cacheRoot(), "cache", "thumbs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Browser-playable proxies for videos whose codec the browser can't decode
 *  (see videoPlayback.js). Same deal as thumbs: a derived, rebuildable cache on
 *  the internal disk — the source video is never touched.
 *  @returns {string} Absolute path to the video-proxy cache dir (created if missing). */
export function videoProxiesDir() {
  const dir = join(cacheRoot(), "cache", "videos");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** @returns {string} Absolute path to the ratings JSON file. */
export function ratingsFile() {
  mkdirSync(cacheRoot(), { recursive: true });
  return join(cacheRoot(), "ratings.json");
}

/** @returns {string} Absolute path to the manual cover-choices JSON file. */
export function coverChoicesFile() {
  mkdirSync(cacheRoot(), { recursive: true });
  return join(cacheRoot(), "coverChoices.json");
}

/** @returns {string} Absolute path to the library (recent-folders) JSON file. */
export function libraryFile() {
  mkdirSync(cacheRoot(), { recursive: true });
  return join(cacheRoot(), "library.json");
}

/** @returns {string} Absolute path to the SQLite index database file. */
export function indexDbFile() {
  mkdirSync(cacheRoot(), { recursive: true });
  return join(cacheRoot(), "index.db");
}

/**
 * Every thumbnail size the client ever requests. ui/src/App.svelte snaps the
 * displayed size to one of these five specifically so the disk cache doesn't
 * fragment per pixel.
 */
export const THUMB_BUCKETS = [160, 320, 480, 640, 1024];

/**
 * Pure computation of the thumbnail cache key (bare SHA1 hex, no path or extension).
 *
 * thumbsDir() calls mkdirSync, which is a blocking syscall. Callers that only
 * need to compare keys against directory listings (cacheStats, pruneOrphanedCache)
 * must use this instead of thumbCachePath to avoid a syscall per photo per bucket
 * in loops spanning 100k+ photos. The invariant "thumbCachePath(photo, size)
 * equals join(thumbsDir(), thumbCacheKey(photo, size) + '.jpg')" is tested and
 * must not drift.
 *
 * @param {{path: string, mtime: number, size: number}} photo
 * @param {number} size one of THUMB_BUCKETS
 * @returns {string} bare 40-char SHA1 hex digest
 */
export function thumbCacheKey(photo, size) {
  return createHash("sha1")
    .update(`${photo.path}:${photo.mtime}:${photo.size}:${size}`)
    .digest("hex");
}

/** Downloaded ML model weights. Deliberately NOT under cache/thumbs/ —
 *  pruneOrphanedCache deletes anything there outside its expected key set,
 *  regardless of extension.
 *  @returns {string} Absolute path to the model cache dir (created if missing). */
export function modelsDir() {
  const dir = join(cacheRoot(), "models");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * THE thumbnail cache path. One definition, because it was two — GET
 * /api/thumb/:id and cacheStats.js each carried a copy, the second admitting in
 * a comment that it was "kept in sync manually". A key formula that drifts
 * doesn't throw; it silently orphans every cached thumbnail, and
 * pruneOrphanedCache then deletes the live cache as garbage.
 *
 * Identity is path + mtime + size (+ bucket), matching the scan/feed identity
 * rule in CLAUDE.md: an edited file gets a new key, so a stale thumbnail can
 * never be served for changed bytes.
 *
 * @param {{path: string, mtime: number, size: number}} photo
 * @param {number} size one of THUMB_BUCKETS
 * @returns {string} absolute path to the cached JPEG (which may not exist yet)
 */
export function thumbCachePath(photo, size) {
  return join(thumbsDir(), `${thumbCacheKey(photo, size)}.jpg`);
}
