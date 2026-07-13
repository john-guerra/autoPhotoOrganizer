import { describe, it, expect } from "vitest";
import {
  parseSort,
  sortSeekDim,
  applySortToDims,
  SORT_ATTRS,
  TAKEN_AT_EXPR,
  effectiveTakenAtMs,
} from "./sort.js";

describe("the taken date", () => {
  // width is the "EXIF extraction was attempted" sentinel; non-null = we looked.
  it("prefers EXIF, then the file's creation date, then mtime", () => {
    const row = { taken_at: 3, btime: 2, mtimeMs: 1, width: 100 };
    expect(effectiveTakenAtMs(row)).toBe(3);
    expect(effectiveTakenAtMs({ ...row, taken_at: null })).toBe(2);
    expect(
      effectiveTakenAtMs({ taken_at: null, btime: null, mtimeMs: 1, width: 0 })
    ).toBe(1);
    expect(effectiveTakenAtMs({})).toBe(null);
  });

  it("does NOT guess a date for a photo whose EXIF has not been read yet", () => {
    // Enrichment is lazy: width === null means nobody has opened this file. If
    // we dated it by btime now, the photo would silently JUMP to another group
    // the moment it scrolled into view and its real EXIF date arrived.
    expect(
      effectiveTakenAtMs({ taken_at: null, btime: 2, mtimeMs: 1, width: null })
    ).toBe(null);
    // Once read (even a RAW, which reports width 0), the fallback applies.
    expect(
      effectiveTakenAtMs({ taken_at: null, btime: 2, mtimeMs: 1, width: 0 })
    ).toBe(2);
  });

  it("groups by the GUARDED date but sorts by an unconditional one", () => {
    // Grouping must not invent a date for an un-read photo (it would move
    // later); sorting must never see a NULL (it would clump them all at one
    // end). Hence two exprs — this pins the distinction so a well-meaning
    // "let's use one expression" refactor has to argue with a red test.
    const [dim] = applySortToDims(
      [{ name: "day", expr: "x", direction: "ASC" }],
      { by: "date_taken", dir: "desc" }
    );
    expect(dim.expr).toContain(TAKEN_AT_EXPR);
    expect(TAKEN_AT_EXPR).toContain("width IS NOT NULL");
    expect(SORT_ATTRS.date_taken.expr).not.toContain("width");
  });
});

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
