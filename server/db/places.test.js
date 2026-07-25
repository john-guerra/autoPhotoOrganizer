import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import {
  backfillPlaces,
  backfillPlacesBatch,
  stampPlacelessPhotos,
  _resetBackfillForTest,
} from "./places.js";
import { PLACE_VERSION } from "../lib/place.js";

const noIdle = () => Promise.resolve();

/**
 * #175. The bug this guards is not "the geocoder is wrong" (place.test.js owns
 * that) but "the geocoder got better and nobody's library noticed": every
 * already-scanned photo has gps_checked = 1, which permanently excludes it from
 * the metadata sweep, so without this backfill a fixed geocoder would still
 * show San Francisco photos as "Half Moon Bay" forever.
 */
describe("backfillPlaces", () => {
  let db;
  beforeEach(() => {
    _resetBackfillForTest();
    db = new Database(":memory:");
    applySchema(db);
    db.prepare(`INSERT INTO folders (id, abs_path) VALUES (1, '/lib')`).run();
  });

  function insert({ id, lat, lon, country, city, version, gpsChecked = 1 }) {
    db.prepare(
      `INSERT INTO photos
         (id, folder_id, filename, size, mtime, kind,
          lat, lon, place_country, place_city, gps_checked, place_version)
       VALUES (@id, 1, @filename, 10, 10, 'image',
          @lat, @lon, @country, @city, @gpsChecked, @version)`
    ).run({
      id,
      filename: `p${id}.jpg`,
      lat,
      lon,
      country,
      city,
      gpsChecked,
      version,
    });
  }
  const read = (id) =>
    db
      .prepare(
        `SELECT place_country, place_city, place_version FROM photos WHERE id = ?`
      )
      .get(id);

  it("re-derives a stale place name and stamps the new version", async () => {
    // Exactly the reported case: SF coordinates, stored under the old dataset's
    // wrong answer, marked as already GPS-checked.
    insert({
      id: 1,
      lat: 37.758,
      lon: -122.426,
      country: "United States",
      city: "Half Moon Bay",
      version: 0,
    });

    expect((await backfillPlaces(db, { idle: noIdle })).updated).toBe(1);

    const row = read(1);
    expect(row.place_city).toBe("San Francisco");
    expect(row.place_version).toBe(PLACE_VERSION);
  });

  it("leaves rows already at the current version alone", async () => {
    // A deliberately wrong name at the CURRENT version must not be touched —
    // proves the gate keys on the version, not on whether the name looks odd.
    insert({
      id: 1,
      lat: 37.758,
      lon: -122.426,
      country: "United States",
      city: "Sentinel",
      version: PLACE_VERSION,
    });

    expect((await backfillPlaces(db, { idle: noIdle })).updated).toBe(0);
    expect(read(1).place_city).toBe("Sentinel");
  });

  it("is idempotent: a second run has nothing left to do", async () => {
    insert({
      id: 1,
      lat: 37.758,
      lon: -122.426,
      country: "",
      city: "",
      version: 0,
    });
    expect((await backfillPlaces(db, { idle: noIdle })).updated).toBe(1);
    expect((await backfillPlaces(db, { idle: noIdle })).updated).toBe(0);
  });

  it("ignores photos with no coordinates", async () => {
    insert({
      id: 1,
      lat: null,
      lon: null,
      country: "",
      city: "",
      version: 0,
    });
    expect((await backfillPlaces(db, { idle: noIdle })).updated).toBe(0);
  });

  it("drains across multiple batches when a limit forces it", async () => {
    // The whole point of batching (over one big transaction) is that it keeps
    // looping until nothing is left, not just once. A limit smaller than the
    // pending set is what actually exercises that loop.
    for (let id = 1; id <= 5; id++) {
      insert({
        id,
        lat: 37.758,
        lon: -122.426,
        country: "",
        city: "",
        version: 0,
      });
    }
    const result = await backfillPlaces(db, { idle: noIdle, limit: 2 });
    expect(result.updated).toBe(5);
    for (let id = 1; id <= 5; id++) {
      expect(read(id).place_city).toBe("San Francisco");
    }
  });

  it("a batch reports whether more work remains", () => {
    for (let id = 1; id <= 3; id++) {
      insert({
        id,
        lat: 37.758,
        lon: -122.426,
        country: "",
        city: "",
        version: 0,
      });
    }
    const first = backfillPlacesBatch(db, { limit: 2 });
    expect(first).toEqual({ updated: 2, remaining: true });
    const second = backfillPlacesBatch(db, { limit: 2 });
    expect(second).toEqual({ updated: 1, remaining: false });
  });

  it("is single-flight: a concurrent call is a no-op, not a duplicate drain", async () => {
    insert({
      id: 1,
      lat: 37.758,
      lon: -122.426,
      country: "",
      city: "",
      version: 0,
    });
    const [a, b] = await Promise.all([
      backfillPlaces(db, { idle: noIdle }),
      backfillPlaces(db, { idle: noIdle }),
    ]);
    // One of the two did the work; the other found it already running.
    const results = [a, b];
    expect(results.filter((r) => r.alreadyRunning).length).toBe(1);
    expect(results.reduce((sum, r) => sum + r.updated, 0)).toBe(1);
  });

  it("stamps GPS-less photos so they stop being re-examined every startup", () => {
    insert({ id: 1, lat: null, lon: null, country: "", city: "", version: 0 });
    expect(stampPlacelessPhotos(db).stamped).toBe(1);
    expect(read(1).place_version).toBe(PLACE_VERSION);
    // And they keep the Unknown sentinel, not a bogus name.
    expect(read(1).place_city).toBe("");
    expect(stampPlacelessPhotos(db).stamped).toBe(0);
  });

  it("does not stamp a photo whose GPS has never been read", () => {
    // gps_checked = 0 means the sweep still owes this row a look; stamping it
    // would be claiming a place answer we never computed.
    insert({
      id: 1,
      lat: null,
      lon: null,
      country: "",
      city: "",
      version: 0,
      gpsChecked: 0,
    });
    expect(stampPlacelessPhotos(db).stamped).toBe(0);
    expect(read(1).place_version).toBe(0);
  });
});
