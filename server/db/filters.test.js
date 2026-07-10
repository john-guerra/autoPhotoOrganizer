import { describe, it, expect } from "vitest";
import { buildFilter, ALLOWED_ORIENTATIONS } from "./filters.js";

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

  it("emits a COALESCE(taken_at,mtime) range for dateFrom/dateTo", () => {
    const both = buildFilter({ dateFrom: 1000, dateTo: 2000 });
    expect(both.sql).toBe(
      "COALESCE(photos.taken_at, photos.mtime) >= ? AND COALESCE(photos.taken_at, photos.mtime) <= ?"
    );
    expect(both.params).toEqual([1000, 2000]);

    const fromOnly = buildFilter({ dateFrom: 1000 });
    expect(fromOnly.sql).toBe("COALESCE(photos.taken_at, photos.mtime) >= ?");
    expect(fromOnly.params).toEqual([1000]);

    const toOnly = buildFilter({ dateTo: 2000 });
    expect(toOnly.sql).toBe("COALESCE(photos.taken_at, photos.mtime) <= ?");
    expect(toOnly.params).toEqual([2000]);

    expect(buildFilter({ dateFrom: null, dateTo: null })).toEqual({
      sql: "1=1",
      params: [],
    });
  });

  it("AND-composes the time range with a rating facet, params in order", () => {
    const f = buildFilter({ minRating: 4, dateFrom: 1000, dateTo: 2000 });
    expect(f.sql).toBe(
      "photos.rating >= ? AND COALESCE(photos.taken_at, photos.mtime) >= ? AND COALESCE(photos.taken_at, photos.mtime) <= ?"
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
      "COALESCE(photos.taken_at, photos.mtime) >= ?"
    );
    // dateAttr alone (no bounds) constrains nothing.
    expect(buildFilter({ dateAttr: "date_modified" })).toEqual({
      sql: "1=1",
      params: [],
    });
  });
});
