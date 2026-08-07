import { describe, it, expect } from "vitest";
import { birthTimeSuspicion, dateRows, suspicionNote } from "./photoDates.js";

/**
 * The values here are REAL, taken from the library that produced #349 —
 * `PXL_20250102_015856109.MP.jpg`, one of 1,557 files with the identical
 * birth time. A made-up constant would have proved the rule matches itself.
 */
const REAL = {
  takenAtExif: 1735783136000, // 2025-01-02T01:58:56Z — EXIF, correct
  btime: 443779200000, // 1984-01-24T08:00:00Z — the sentinel
  mtime: 1735783137000, // 2025-01-02T01:58:57Z — correct
};

describe("birthTimeSuspicion", () => {
  it("catches the exact value macOS reported for 1,557 real files", () => {
    expect(birthTimeSuspicion(REAL.btime)).toBe("mac-epoch");
  });

  it("catches the same day written from another timezone", () => {
    // The stored value carries the local zone of whatever wrote it — 08:00Z
    // here is midnight Pacific. Sydney would write the same day as a
    // different instant, and an equality check against one instant would sail
    // straight past it.
    expect(birthTimeSuspicion(Date.UTC(1984, 0, 23, 13, 0))).toBe("mac-epoch");
    expect(birthTimeSuspicion(Date.UTC(1984, 0, 24, 23, 30))).toBe("mac-epoch");
  });

  it("leaves ordinary dates alone", () => {
    expect(birthTimeSuspicion(REAL.mtime)).toBe(null);
    expect(birthTimeSuspicion(Date.UTC(1999, 5, 1))).toBe(null);
    // The boundary itself is trustworthy, not suspicious.
    expect(birthTimeSuspicion(Date.UTC(1990, 0, 1))).toBe(null);
  });

  it("flags anything before digital photography, not just the Mac date", () => {
    expect(birthTimeSuspicion(0)).toBe("implausible"); // the unix epoch
    expect(birthTimeSuspicion(Date.UTC(1970, 0, 2))).toBe("implausible");
  });

  it("says nothing about a missing or nonsense value", () => {
    // Absent is not suspicious — it is absent, and the UI shows a dash.
    expect(birthTimeSuspicion(null)).toBe(null);
    expect(birthTimeSuspicion(undefined)).toBe(null);
    expect(birthTimeSuspicion(NaN)).toBe(null);
  });
});

describe("dateRows", () => {
  it("names the row that is deciding this photo's position", () => {
    // The bug report exactly: sorting by Created puts this 2025 photo in 1984.
    const rows = dateRows(REAL, "date_created");
    const driving = rows.filter((r) => r.drives);
    expect(driving).toHaveLength(1);
    expect(driving[0].key).toBe("btime");
    expect(driving[0].note).toContain("not a real date");
  });

  it("blames EXIF when the sort is Taken and EXIF exists", () => {
    const rows = dateRows(REAL, "date_taken");
    expect(rows.find((r) => r.drives).key).toBe("exif");
  });

  it("falls through to the file date when EXIF was never read", () => {
    // This is the case where a bad btime reaches a Taken sort too, so the
    // marker has to follow the COALESCE rather than assume EXIF wins.
    const rows = dateRows({ ...REAL, takenAtExif: null }, "date_taken");
    expect(rows.find((r) => r.drives).key).toBe("btime");
  });

  it("marks nothing when the feed is not sorted by a date at all", () => {
    expect(dateRows(REAL, "rating").some((r) => r.drives)).toBe(false);
  });

  it("returns nothing rather than a row of dashes with no meta", () => {
    expect(dateRows(null, "date_created")).toEqual([]);
  });

  it("keeps the three dates unmerged, which is the entire point", () => {
    const rows = dateRows(REAL, "date_created");
    expect(rows.map((r) => r.ms)).toEqual([
      REAL.takenAtExif,
      REAL.btime,
      REAL.mtime,
    ]);
  });
});

describe("suspicionNote", () => {
  it("explains rather than just labelling", () => {
    expect(suspicionNote("mac-epoch")).toMatch(/no creation date/i);
    expect(suspicionNote(null)).toBe("");
  });
});
