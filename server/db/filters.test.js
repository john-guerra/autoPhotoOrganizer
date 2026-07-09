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
    expect(buildFilter({ orientations: [] })).toEqual({ sql: "1=1", params: [] });
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
    const f = buildFilter({ orientations: ["portrait", "portrait", "landscape"] });
    expect(f.sql).toBe(
      "photos.width > 0 AND photos.height > 0 AND (photos.width > photos.height OR photos.height > photos.width)"
    );
  });
});
