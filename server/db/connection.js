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
  // stampPlacelessPhotos is a single indexed UPDATE, cheap even at scale — kept
  // synchronous. backfillPlaces is NOT: it calls the geocoder per photo, so on
  // a library where PLACE_VERSION just moved (an upgrade, not the common case)
  // it can be real, non-trivial work. It used to run here too, synchronously,
  // before app.listen() — the whole app, UI included, blocked on it with no
  // progress shown, on the very release that guaranteed the block would fire.
  // Fire-and-forget instead (matches hashAllPending's own call-site
  // convention): idle-gated and batched in places.js, so it never competes
  // with an interactive request and never holds up startup. The trade caught
  // in review: a feed grouped by city, queried mid-backfill on a huge library,
  // can briefly show the same trip under both the old and new name until the
  // drain catches up — accepted as the same eventual-consistency trade the
  // metadata/hash sweeps already make, and strictly better than freezing the
  // app to avoid it.
  stampPlacelessPhotos(db);
  backfillPlaces(db).catch(() => {});
  return db;
}

/** Close and drop the cached connection (tests only). */
export function _resetDbForTest() {
  if (db) {
    db.close();
    db = null;
  }
}
