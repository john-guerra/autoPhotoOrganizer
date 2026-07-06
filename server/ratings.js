import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { ratingsFile } from "./lib/cachePaths.js";

/**
 * Ratings persistence.
 *
 * Ratings are keyed by ABSOLUTE file path (not scan id) so they survive rescans
 * and re-orderings. Stored as a single JSON object at ~/.autogallery/ratings.json.
 * Writes are atomic (temp file + rename) and debounced so a burst of keystrokes
 * during culling coalesces into one disk write.
 */

/** @type {Record<string, number> | null} */
let cache = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null;
const DEBOUNCE_MS = 150;

/** Load the ratings map from disk (cached in memory). */
function load() {
  if (cache) return cache;
  const file = ratingsFile();
  if (existsSync(file)) {
    try {
      cache = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      cache = {};
    }
  } else {
    cache = {};
  }
  return cache;
}

/** Atomically write the in-memory map to disk (temp + rename). */
function flush() {
  flushTimer = null;
  const file = ratingsFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache ?? {}, null, 2));
  renameSync(tmp, file);
}

/** Schedule a debounced flush. */
function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, DEBOUNCE_MS);
}

/** @returns {Record<string, number>} A copy of all ratings keyed by absolute path. */
export function getAllRatings() {
  return { ...load() };
}

/**
 * Set (or clear, when rating is 0) the rating for an absolute path.
 * @param {string} absPath
 * @param {number} rating 0-5 (0 clears)
 */
export function setRating(absPath, rating) {
  const map = load();
  if (rating === 0) delete map[absPath];
  else map[absPath] = rating;
  scheduleFlush();
}

/**
 * Force a synchronous flush of any pending debounced write.
 * Useful for tests and graceful shutdown.
 */
export function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flush();
  }
}

/** Reset in-memory cache (tests only). */
export function _resetForTest() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  cache = null;
}
