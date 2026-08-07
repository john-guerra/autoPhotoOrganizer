import { describe, it, expect } from "vitest";
import {
  parseSort,
  sortSeekDim,
  applySortToDims,
  SORT_ATTRS,
  TAKEN_AT_EXPR,
  effectiveTakenAtMs,
  trustedBtime,
  BTIME_FLOOR_MS,
} from "./sort.js";

/**
 * Real epoch-ms, because the sentinel guard (#349) makes small integers
 * meaningless here: `btime: 2` is 1970, which is now correctly refused. These
 * are the actual values from the photo John reported.
 */
const EXIF = 1735783136000; // 2025-01-02T01:58:56Z
const MTIME = 1735783137000; // 2025-01-02T01:58:57Z
const BTIME = 1735783135000; // a second earlier - a plausible birth time
const MAC_SENTINEL = 443779200000; // 1984-01-24T08:00:00Z

describe("the taken date", () => {
  // width is the "EXIF extraction was attempted" sentinel; non-null = we looked.
  it("prefers EXIF, then the file's creation date, then mtime", () => {
    const row = { taken_at: EXIF, btime: BTIME, mtimeMs: MTIME, width: 100 };
    expect(effectiveTakenAtMs(row)).toBe(EXIF);
    expect(effectiveTakenAtMs({ ...row, taken_at: null })).toBe(BTIME);
    expect(
      effectiveTakenAtMs({
        taken_at: null,
        btime: null,
        mtimeMs: MTIME,
        width: 0,
      })
    ).toBe(MTIME);
    expect(effectiveTakenAtMs({})).toBe(null);
  });

  it("falls through a SENTINEL creation date to mtime (#349)", () => {
    // The reported bug: 1,557 of John's photos carried btime 1984-01-24, the
    // value macOS writes when a file has no creation date of its own. EXIF and
    // mtime both said 2025, and "sort by Created" put them all in 1984.
    expect(
      effectiveTakenAtMs({
        taken_at: null,
        btime: MAC_SENTINEL,
        mtimeMs: MTIME,
        width: 100,
      })
    ).toBe(MTIME);
    // EXIF still wins outright when we have it - this guard is about the FILE
    // dates, and never overrides what the camera recorded.
    expect(
      effectiveTakenAtMs({
        taken_at: EXIF,
        btime: MAC_SENTINEL,
        mtimeMs: MTIME,
        width: 100,
      })
    ).toBe(EXIF);
  });

  it("does NOT guess a date for a photo whose EXIF has not been read yet", () => {
    // Enrichment is lazy: width === null means nobody has opened this file. If
    // we dated it by btime now, the photo would silently JUMP to another group
    // the moment it scrolled into view and its real EXIF date arrived.
    expect(
      effectiveTakenAtMs({
        taken_at: null,
        btime: BTIME,
        mtimeMs: MTIME,
        width: null,
      })
    ).toBe(null);
    // Once read (even a RAW, which reports width 0), the fallback applies.
    expect(
      effectiveTakenAtMs({
        taken_at: null,
        btime: BTIME,
        mtimeMs: MTIME,
        width: 0,
      })
    ).toBe(BTIME);
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

describe("the sentinel creation date (#349)", () => {
  it("refuses the exact value macOS wrote on 1,557 of John's files", () => {
    expect(trustedBtime(MAC_SENTINEL)).toBe(null);
    // ...and the other common sentinel, the unix epoch.
    expect(trustedBtime(0)).toBe(null);
    expect(trustedBtime(null)).toBe(null);
  });

  it("keeps every plausible creation date", () => {
    expect(trustedBtime(BTIME)).toBe(BTIME);
    // The floor itself is trustworthy, not suspicious.
    expect(trustedBtime(BTIME_FLOOR_MS)).toBe(BTIME_FLOOR_MS);
    expect(trustedBtime(BTIME_FLOOR_MS - 1)).toBe(null);
  });

  it("guards BOTH date sorts, not just Created", () => {
    // A photo whose EXIF has not been read reaches the file dates under Taken
    // too, so fixing only date_created would leave Taken misfiling the same
    // photos. Both exprs must carry the floor.
    expect(SORT_ATTRS.date_created.expr).toContain(String(BTIME_FLOOR_MS));
    expect(SORT_ATTRS.date_taken.expr).toContain(String(BTIME_FLOOR_MS));
    // date_modified is mtime alone and must NOT acquire the guard.
    expect(SORT_ATTRS.date_modified.expr).not.toContain(String(BTIME_FLOOR_MS));
  });

  it("agrees with SQLite — the SQL and its JS twin give the same answer", async () => {
    // sort.js's standing rule is that TAKEN_AT_EXPR and effectiveTakenAtMs
    // must stay in lockstep: the SQL groups the feed, the JS labels the row
    // that lands in it. Asserting on the expression STRING would only prove it
    // contains a number, so this runs the real expression through real SQLite
    // and compares the two answers row by row.
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE photos (
      id INTEGER PRIMARY KEY, taken_at INTEGER, btime INTEGER,
      mtime INTEGER, width INTEGER)`);
    const rows = [
      { id: 1, taken_at: EXIF, btime: MAC_SENTINEL, mtime: MTIME, width: 100 },
      { id: 2, taken_at: null, btime: MAC_SENTINEL, mtime: MTIME, width: 100 },
      { id: 3, taken_at: null, btime: BTIME, mtime: MTIME, width: 100 },
      { id: 4, taken_at: null, btime: null, mtime: MTIME, width: 100 },
      { id: 5, taken_at: null, btime: 0, mtime: MTIME, width: 100 },
    ];
    const ins = db.prepare(
      `INSERT INTO photos VALUES (@id, @taken_at, @btime, @mtime, @width)`
    );
    for (const r of rows) ins.run(r);

    const sql = db
      .prepare(`SELECT id, ${TAKEN_AT_EXPR} AS d FROM photos ORDER BY id`)
      .all();
    for (const row of rows) {
      const fromSql = sql.find((r) => r.id === row.id).d;
      expect(fromSql, `row ${row.id}`).toBe(effectiveTakenAtMs(row));
    }
    // And the specific thing the user reported: the sentinel row does not
    // land in 1984.
    expect(new Date(sql.find((r) => r.id === 2).d).getUTCFullYear()).toBe(2025);
    db.close();
  });
});
