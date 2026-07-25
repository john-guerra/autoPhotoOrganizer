import Database from "better-sqlite3";
import { indexDbFile } from "../lib/cachePaths.js";
import { applySchema } from "./schema.js";
import { backfillPlaces, stampPlacelessPhotos } from "./places.js";

/** @type {import("better-sqlite3").Database | null} */
let db = null;

/** @returns {import("better-sqlite3").Database} */
export function getDb() {
  if (db) return db;
  db = new Database(indexDbFile());
  db.pragma("journal_mode = WAL");
  applySchema(db);
  // Synchronous, and deliberately so: these re-derive the place NAMES shown in
  // the feed from coordinates already in the index, and a feed query that
  // arrived mid-backfill would group the same trip under two different city
  // names at once. Both are no-ops (one indexed COUNT) unless the geocoder
  // version actually moved, and neither touches the filesystem. See places.js.
  stampPlacelessPhotos(db);
  backfillPlaces(db);
  return db;
}

/** Close and drop the cached connection (tests only). */
export function _resetDbForTest() {
  if (db) {
    db.close();
    db = null;
  }
}
