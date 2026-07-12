import { describe, it, expect } from "vitest";
import { parseSort, sortSeekDim, applySortToDims, SORT_ATTRS } from "./sort.js";

describe("parseSort", () => {
  it("defaults to date_taken:asc", () => {
    expect(parseSort(undefined)).toEqual({ by: "date_taken", dir: "asc" });
  });
  it("parses a valid by:dir", () => {
    expect(parseSort("rating:desc")).toEqual({ by: "rating", dir: "desc" });
  });
  it("rejects unknown attribute and bad direction", () => {
    expect(parseSort("bogus:sideways")).toEqual({
      by: "date_taken",
      dir: "asc",
    });
  });
});

describe("sortSeekDim", () => {
  it("uses the attribute expr and upper-cased direction", () => {
    expect(sortSeekDim({ by: "rating", dir: "asc" })).toEqual({
      name: "__sort",
      expr: SORT_ATTRS.rating.expr,
      direction: "ASC",
    });
  });
});

describe("applySortToDims", () => {
  const dims = [
    { name: "month", expr: "OLD_MONTH", direction: "DESC" },
    { name: "folder", expr: "folders.abs_path", direction: "ASC" },
  ];
  it("rewrites date dims to the sort's date source + direction", () => {
    const out = applySortToDims(dims, { by: "date_created", dir: "asc" });
    expect(out[0].expr).toContain("photos.btime");
    expect(out[0].direction).toBe("ASC");
    expect(out[1]).toEqual(dims[1]); // non-date dim untouched
  });
  it("leaves date dims at default (taken, DESC) for a non-date sort", () => {
    const out = applySortToDims(dims, { by: "rating", dir: "asc" });
    expect(out[0].expr).toContain("photos.taken_at");
    expect(out[0].direction).toBe("DESC");
  });
});
