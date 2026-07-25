import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { buildFilter, ALLOWED_ORIENTATIONS, ALLOWED_KINDS } from "./filters.js";

/** A tiny real database — the text facet is about what SQLite MATCHES, so
 *  asserting on the SQL string would prove nothing about the search box. */
function seeded() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE folders (id INTEGER PRIMARY KEY, abs_path TEXT);
    CREATE TABLE photos (
      id INTEGER PRIMARY KEY, filename TEXT, folder_id INTEGER, stale INTEGER DEFAULT 0,
      place_country TEXT DEFAULT '', place_region TEXT DEFAULT '', place_city TEXT DEFAULT '',
      place_neighborhood TEXT DEFAULT ''
    );
  `);
  const folder = db.prepare("INSERT INTO folders (id, abs_path) VALUES (?, ?)");
  folder.run(1, "/photos/tayrona");
  folder.run(2, "/photos/misc");
  const photo = db.prepare(
    "INSERT INTO photos (filename, folder_id) VALUES (?, ?)"
  );
  photo.run("a.jpg", 1);
  photo.run("b.jpg", 1);
  photo.run("sunset.jpg", 2);
  photo.run("100%_done.jpg", 2); // a literal % — LIKE's wildcard, as a filename
  db.prepare(
    "INSERT INTO photos (filename, folder_id, place_country, place_region, place_city, place_neighborhood) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("gps.jpg", 2, "Colombia", "Cundinamarca", "La Calera", "El Salitre");
  return db;
}

/** The filenames a spec actually selects. */
function namesMatching(db, spec) {
  const f = buildFilter(spec);
  return db
    .prepare(
      `SELECT photos.filename AS name
         FROM photos JOIN folders ON folders.id = photos.folder_id
        WHERE photos.stale = 0 AND (${f.sql})
        ORDER BY photos.id`
    )
    .all(...f.params)
    .map((r) => r.name);
}

describe("buildFilter", () => {
  it("returns a no-op for an empty spec", () => {
    expect(buildFilter({})).toEqual({ sql: "1=1", params: [] });
    expect(buildFilter()).toEqual({ sql: "1=1", params: [] });
  });

  it("minRating 0 is a no-op; N>0 emits a bound rating clause", () => {
    expect(buildFilter({ minRating: 0 })).toEqual({ sql: "1=1", params: [] });
    const f = buildFilter({ minRating: 4 });
    expect(f.sql).toBe("photos.rating >= ?");
    expect(f.params).toEqual([4]);
  });

  it("all three (or zero) orientations is a no-op", () => {
    expect(buildFilter({ orientations: ALLOWED_ORIENTATIONS })).toEqual({
      sql: "1=1",
      params: [],
    });
    expect(buildFilter({ orientations: [] })).toEqual({
      sql: "1=1",
      params: [],
    });
  });

  it("a strict orientation subset emits a positive-dimension-guarded OR", () => {
    const f = buildFilter({ orientations: ["landscape", "portrait"] });
    expect(f.sql).toBe(
      "photos.width > 0 AND photos.height > 0 AND (photos.width > photos.height OR photos.height > photos.width)"
    );
    expect(f.params).toEqual([]);
  });

  it("all (or zero) kinds is a no-op", () => {
    expect(buildFilter({ kinds: ALLOWED_KINDS })).toEqual({
      sql: "1=1",
      params: [],
    });
    expect(buildFilter({ kinds: [] })).toEqual({ sql: "1=1", params: [] });
  });

  it("a strict kind subset emits a bound IN clause", () => {
    const f = buildFilter({ kinds: ["video"] });
    expect(f.sql).toBe("photos.kind IN (?)");
    expect(f.params).toEqual(["video"]);
  });

  it("kinds are normalized to canonical order and unknown names dropped", () => {
    const f = buildFilter({ kinds: ["video", "bogus", "image"] });
    expect(f.sql).toBe("photos.kind IN (?,?)");
    expect(f.params).toEqual(["image", "video"]);
  });

  it("combines a kind facet with a rating facet, rating first", () => {
    const f = buildFilter({ minRating: 2, kinds: ["image", "raw"] });
    expect(f.sql).toBe("photos.rating >= ? AND photos.kind IN (?,?)");
    expect(f.params).toEqual([2, "image", "raw"]);
  });

  it("single orientation: portrait", () => {
    const f = buildFilter({ orientations: ["portrait"] });
    expect(f.sql).toBe(
      "photos.width > 0 AND photos.height > 0 AND (photos.height > photos.width)"
    );
  });

  it("combines rating and orientation with AND, rating first", () => {
    const f = buildFilter({ minRating: 5, orientations: ["square"] });
    expect(f.sql).toBe(
      "photos.rating >= ? AND photos.width > 0 AND photos.height > 0 AND (photos.width = photos.height)"
    );
    expect(f.params).toEqual([5]);
  });

  it("ignores unknown orientation names", () => {
    const f = buildFilter({ orientations: ["portrait", "bogus"] });
    expect(f.sql).toBe(
      "photos.width > 0 AND photos.height > 0 AND (photos.height > photos.width)"
    );
  });

  it("de-duplicates orientation names before the all-off length check", () => {
    const f = buildFilter({
      orientations: ["portrait", "portrait", "landscape"],
    });
    expect(f.sql).toBe(
      "photos.width > 0 AND photos.height > 0 AND (photos.width > photos.height OR photos.height > photos.width)"
    );
  });

  it("scopes to an explicit id set (keep-only), integers only, bound params", () => {
    const f = buildFilter({ scopeIds: [3, 7, 9] });
    expect(f.sql).toBe("photos.id IN (?,?,?)");
    expect(f.params).toEqual([3, 7, 9]);
  });

  it("drops non-integer scopeIds and treats an empty scope as no-op", () => {
    const f = buildFilter({ scopeIds: [1, "x", 2.5, null, 4] });
    expect(f.sql).toBe("photos.id IN (?,?)");
    expect(f.params).toEqual([1, 4]);
    expect(buildFilter({ scopeIds: [] })).toEqual({ sql: "1=1", params: [] });
  });

  it("combines a rating filter and a keep-only scope", () => {
    const f = buildFilter({ minRating: 4, scopeIds: [10, 11] });
    expect(f.sql).toBe("photos.rating >= ? AND photos.id IN (?,?)");
    expect(f.params).toEqual([4, 10, 11]);
  });

  it("keepScope emits a table subquery with no params (unbounded size)", () => {
    const f = buildFilter({ keepScope: true });
    expect(f.sql).toBe("photos.id IN (SELECT photo_id FROM keep_scope)");
    expect(f.params).toEqual([]);
  });

  it("combines a rating filter with keepScope", () => {
    const f = buildFilter({ minRating: 3, keepScope: true });
    expect(f.sql).toBe(
      "photos.rating >= ? AND photos.id IN (SELECT photo_id FROM keep_scope)"
    );
    expect(f.params).toEqual([3]);
  });

  it("folderPath scopes to a subtree via a folder_id subquery (works without a folders JOIN)", () => {
    const f = buildFilter({ folderPath: "/photos/trip" });
    expect(f.sql).toBe(
      "photos.folder_id IN (SELECT id FROM folders WHERE abs_path = ? OR abs_path LIKE ? ESCAPE '\\')"
    );
    // Exact arm gets the raw path; LIKE arm gets `path + "/%"`.
    expect(f.params).toEqual(["/photos/trip", "/photos/trip/%"]);
  });

  it("folderPath escapes LIKE metacharacters (%, _, \\) in the prefix only", () => {
    const f = buildFilter({ folderPath: "/a/50%_off\\stuff" });
    // Exact arm is the raw path; only the LIKE prefix is escaped.
    expect(f.params).toEqual([
      "/a/50%_off\\stuff",
      "/a/50\\%\\_off\\\\stuff/%",
    ]);
  });

  it("empty/absent folderPath is a no-op", () => {
    expect(buildFilter({ folderPath: "" })).toEqual({ sql: "1=1", params: [] });
    expect(buildFilter({})).toEqual({ sql: "1=1", params: [] });
  });

  it("combines folderPath with a rating facet and keepScope, params in order", () => {
    const f = buildFilter({ minRating: 4, keepScope: true, folderPath: "/x" });
    expect(f.sql).toBe(
      "photos.rating >= ? AND photos.id IN (SELECT photo_id FROM keep_scope) AND photos.folder_id IN (SELECT id FROM folders WHERE abs_path = ? OR abs_path LIKE ? ESCAPE '\\')"
    );
    expect(f.params).toEqual([4, "/x", "/x/%"]);
  });

  it("emits a COALESCE(taken_at,btime,mtime) range for dateFrom/dateTo", () => {
    const both = buildFilter({ dateFrom: 1000, dateTo: 2000 });
    expect(both.sql).toBe(
      "COALESCE(photos.taken_at, photos.btime, photos.mtime) >= ? AND COALESCE(photos.taken_at, photos.btime, photos.mtime) <= ?"
    );
    expect(both.params).toEqual([1000, 2000]);

    const fromOnly = buildFilter({ dateFrom: 1000 });
    expect(fromOnly.sql).toBe(
      "COALESCE(photos.taken_at, photos.btime, photos.mtime) >= ?"
    );
    expect(fromOnly.params).toEqual([1000]);

    const toOnly = buildFilter({ dateTo: 2000 });
    expect(toOnly.sql).toBe(
      "COALESCE(photos.taken_at, photos.btime, photos.mtime) <= ?"
    );
    expect(toOnly.params).toEqual([2000]);

    expect(buildFilter({ dateFrom: null, dateTo: null })).toEqual({
      sql: "1=1",
      params: [],
    });
  });

  it("AND-composes the time range with a rating facet, params in order", () => {
    const f = buildFilter({ minRating: 4, dateFrom: 1000, dateTo: 2000 });
    expect(f.sql).toBe(
      "photos.rating >= ? AND COALESCE(photos.taken_at, photos.btime, photos.mtime) >= ? AND COALESCE(photos.taken_at, photos.btime, photos.mtime) <= ?"
    );
    expect(f.params).toEqual([4, 1000, 2000]);
  });

  it("dateAttr picks which date column the time bounds filter on", () => {
    expect(buildFilter({ dateFrom: 1000, dateAttr: "date_modified" }).sql).toBe(
      "photos.mtime >= ?"
    );
    expect(buildFilter({ dateTo: 2000, dateAttr: "date_created" }).sql).toBe(
      "COALESCE(photos.btime, photos.mtime) <= ?"
    );
    // Default / unknown attr falls back to date_taken (EXIF-created).
    expect(buildFilter({ dateFrom: 1000, dateAttr: "name" }).sql).toBe(
      "COALESCE(photos.taken_at, photos.btime, photos.mtime) >= ?"
    );
    // dateAttr alone (no bounds) constrains nothing.
    expect(buildFilter({ dateAttr: "date_modified" })).toEqual({
      sql: "1=1",
      params: [],
    });
  });
});

describe("buildFilter — free-text search", () => {
  it("matches a photo by its filename, case-insensitively", () => {
    const db = seeded();
    expect(namesMatching(db, { text: "SUNSET" })).toEqual(["sunset.jpg"]);
  });

  it("matches every photo in a folder whose PATH contains the query", () => {
    // What you actually remember is the trip, not the file: "tayrona" has to
    // find the photos inside /photos/tayrona even though no filename says it.
    const db = seeded();
    expect(namesMatching(db, { text: "tayrona" }).sort()).toEqual([
      "a.jpg",
      "b.jpg",
    ]);
  });

  it("treats a literal % as a character to find, not a wildcard", () => {
    // Unescaped, "%" is LIKE's match-everything — the search box would silently
    // return the whole library for a keystroke that should return one file.
    const db = seeded();
    expect(namesMatching(db, { text: "%" })).toEqual(["100%_done.jpg"]);
  });

  it("is off when the query is empty or only whitespace", () => {
    const db = seeded();
    expect(namesMatching(db, { text: "   " }).length).toBe(5);
    expect(namesMatching(db, {}).length).toBe(5);
  });

  it("matches a photo by its country, region, city, or neighbourhood (place), not just filename/folder", () => {
    const db = seeded();
    expect(namesMatching(db, { text: "Colombia" })).toEqual(["gps.jpg"]);
    expect(namesMatching(db, { text: "cundinamarca" })).toEqual(["gps.jpg"]);
    expect(namesMatching(db, { text: "la calera" })).toEqual(["gps.jpg"]);
    expect(namesMatching(db, { text: "salitre" })).toEqual(["gps.jpg"]);
  });

  it("free-text search matches the place a photo was taken", () => {
    const { sql, params } = buildFilter({ text: "Bogota" });
    expect(sql).toContain("place_country");
    expect(sql).toContain("place_region");
    expect(sql).toContain("place_city");
    expect(sql).toContain("place_neighborhood");
    expect(
      params.filter((p) => p === "%Bogota%").length
    ).toBeGreaterThanOrEqual(4);
  });

  it("escapes LIKE metacharacters in a place search", () => {
    const { params } = buildFilter({ text: "100%" });
    expect(params.every((p) => !String(p).includes("100%%"))).toBe(true);
    expect(params.some((p) => String(p).includes("100\\%"))).toBe(true);
  });
});
