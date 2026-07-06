import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { libraryFile } from "./lib/cachePaths.js";

/**
 * Library of previously-scanned folders, keyed by ABSOLUTE path so
 * re-scanning the same folder refreshes its entry instead of duplicating
 * it. Stored as a single JSON object at ~/.autogallery/library.json — same
 * atomic-write / debounced-flush pattern as coverChoices.js and ratings.js.
 */

/** @type {Record<string, {name:string, lastScannedAt:number}> | null} */
let cache = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null;
const DEBOUNCE_MS = 150;

function load() {
  if (cache) return cache;
  const file = libraryFile();
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

function flush() {
  flushTimer = null;
  const file = libraryFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache ?? {}, null, 2));
  renameSync(tmp, file);
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, DEBOUNCE_MS);
}

/**
 * Record (or refresh) a scanned folder in the library.
 * @param {string} absPath
 * @param {number} [scannedAt] defaults to Date.now(); overridable for tests
 */
export function recordScan(absPath, scannedAt = Date.now()) {
  const map = load();
  map[absPath] = { name: basename(absPath), lastScannedAt: scannedAt };
  scheduleFlush();
}

/**
 * @returns {Array<{path:string, name:string, lastScannedAt:number}>} all
 * library entries, most-recently-scanned first.
 */
export function getAllLibraryEntries() {
  const map = load();
  return Object.entries(map)
    .map(([path, v]) => ({
      path,
      name: v.name,
      lastScannedAt: v.lastScannedAt,
    }))
    .sort((a, b) => b.lastScannedAt - a.lastScannedAt);
}

/** Force a synchronous flush of any pending debounced write. */
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
