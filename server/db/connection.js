import Database from "better-sqlite3";
import { indexDbFile } from "../lib/cachePaths.js";
import { applySchema } from "./schema.js";

/** @type {import("better-sqlite3").Database | null} */
let db = null;

/** @returns {import("better-sqlite3").Database} */
export function getDb() {
  if (db) return db;
  db = new Database(indexDbFile());
  db.pragma("journal_mode = WAL");
  applySchema(db);
  return db;
}

/** Close and drop the cached connection (tests only). */
export function _resetDbForTest() {
  if (db) {
    db.close();
    db = null;
  }
}
