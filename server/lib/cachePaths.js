import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

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
