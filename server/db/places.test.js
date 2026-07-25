import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { backfillPlaces, stampPlacelessPhotos } from "./places.js";
import { PLACE_VERSION } from "../lib/place.js";

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

  it("re-derives a stale place name and stamps the new version", () => {
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

    expect(backfillPlaces(db).updated).toBe(1);

    const row = read(1);
    expect(row.place_city).toBe("San Francisco");
    expect(row.place_version).toBe(PLACE_VERSION);
  });

  it("leaves rows already at the current version alone", () => {
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

    expect(backfillPlaces(db).updated).toBe(0);
    expect(read(1).place_city).toBe("Sentinel");
  });

  it("is idempotent: a second run has nothing left to do", () => {
    insert({
      id: 1,
      lat: 37.758,
      lon: -122.426,
      country: "",
      city: "",
      version: 0,
    });
    expect(backfillPlaces(db).updated).toBe(1);
    expect(backfillPlaces(db).updated).toBe(0);
  });

  it("ignores photos with no coordinates", () => {
    insert({
      id: 1,
      lat: null,
      lon: null,
      country: "",
      city: "",
      version: 0,
    });
    expect(backfillPlaces(db).updated).toBe(0);
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
