import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { coverChoicesFile } from "./lib/cachePaths.js";

/**
 * Manual burst-cover-choice persistence.
 *
 * Keyed by ABSOLUTE file path (not scan id) so a choice survives rescans
 * and re-orderings, same reasoning as ratings.js. Stored as a single JSON
 * object at ~/.autogallery/coverChoices.json — only paths the user has
 * explicitly marked appear in the map (there is no "false" entry;
 * unmarking deletes the key). Writes are atomic (temp file + rename) and
 * debounced.
 */

/** @type {Record<string, true> | null} */
let cache = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null;
const DEBOUNCE_MS = 150;

/** Load the cover-choices map from disk (cached in memory). */
function load() {
  if (cache) return cache;
  const file = coverChoicesFile();
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
  const file = coverChoicesFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache ?? {}, null, 2));
  renameSync(tmp, file);
}

/** Schedule a debounced flush. */
function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, DEBOUNCE_MS);
}

/** @returns {Record<string, true>} A copy of all manual cover choices keyed by absolute path. */
export function getAllCoverChoices() {
  return { ...load() };
}

/**
 * Set (or clear) the manual cover choice for an absolute path.
 * @param {string} absPath
 * @param {boolean} isCover
 */
export function setCoverChoice(absPath, isCover) {
  const map = load();
  if (isCover) map[absPath] = true;
  else delete map[absPath];
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
