import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import {
  getFeedPage,
  findGroupBoundary,
  photoIdsMatchingFilter,
  photoCountMatchingFilter,
  workingSetTimeline,
  workingSetTimes,
} from "./feed.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-db-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

function seedVolume(db, id) {
  db.prepare(`INSERT INTO volumes (id, label) VALUES (?, ?)`).run(
    id,
    `vol${id}`
  );
}

function setTakenAt(db, id, isoOrNull) {
  db.prepare(`UPDATE photos SET taken_at = ? WHERE id = ?`).run(
    isoOrNull ? Date.parse(isoOrNull) : null,
    id
  );
}

/** Mark EXIF extraction as ATTEMPTED (width is the sentinel — see sort.js). A
 *  freshly-scanned photo has width NULL = "not read yet", and the date fallback
 *  deliberately doesn't fire for those. */
function markExifRead(db, id) {
  db.prepare(`UPDATE photos SET width = 100, height = 100 WHERE id = ?`).run(
    id
  );
}

describe("getFeedPage — composite ordering", () => {
  it("orders by folder ascending when groupBy is ['folder']", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "x.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "y.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, { groupBy: ["folder"], after: 10 });
    expect(items.map((i) => i.groupValues.folder)).toEqual([
      "/photos/a-folder",
      "/photos/b-folder",
    ]);
  });

  it("orders by year descending (newest first) within groupBy ['year']", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b] = upsertScan(db, "/photos/trip", 1, [
      { name: "old.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "new.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, a.id, "2020-01-01T00:00:00.000Z");
    setTakenAt(db, b.id, "2024-01-01T00:00:00.000Z");
    const { items } = getFeedPage(db, { groupBy: ["year"], after: 10 });
    expect(items.map((i) => i.groupValues.year)).toEqual(["2024", "2020"]);
  });

  it("dates a photo with no EXIF by the file's creation date, not Unknown", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [exif, noExif] = upsertScan(db, "/photos/trip", 1, [
      { name: "exif.jpg", size: 1, mtimeMs: 1, kind: "image" },
      // A screenshot / export / SD-card copy: no EXIF, but the filesystem knows
      // when it was created (2017).
      {
        name: "no-exif.jpg",
        size: 1,
        mtimeMs: 1,
        btimeMs: 1497484800000,
        kind: "image",
      },
    ]);
    setTakenAt(db, exif.id, "2020-01-01T00:00:00.000Z");
    markExifRead(db, exif.id);
    markExifRead(db, noExif.id); // we looked; there was genuinely no date
    const { items } = getFeedPage(db, { groupBy: ["year"], after: 10 });
    expect(items.map((i) => i.name)).toEqual(["exif.jpg", "no-exif.jpg"]);
    expect(items.map((i) => i.groupValues.year)).toEqual(["2020", "2017"]);
    // …and it reports that date to the UI, rather than a blank taken date.
    expect(items[1].takenAt).toBe(new Date(1497484800000).toISOString());
  });

  it("leaves a photo whose EXIF has NOT been read yet in Unknown", () => {
    const db = getDb();
    seedVolume(db, 1);
    // Same file as above, but nobody has opened it: enrichment is lazy. Dating
    // it by btime now would move it to another group the moment it is read.
    upsertScan(db, "/photos/trip", 1, [
      {
        name: "unread.jpg",
        size: 1,
        mtimeMs: 1,
        btimeMs: 1497484800000,
        kind: "image",
      },
    ]);
    const { items } = getFeedPage(db, { groupBy: ["year"], after: 10 });
    expect(items[0].groupValues.year).toBe("");
    expect(items[0].takenAt).toBe(null);
  });

  it("applies multiple levels outermost-first, mixed directions", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rowsA = upsertScan(db, "/photos/b-folder", 1, [
      { name: "x.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const rowsB = upsertScan(db, "/photos/a-folder", 1, [
      { name: "y.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, rowsA[0].id, "2020-01-01T00:00:00.000Z");
    setTakenAt(db, rowsB[0].id, "2024-01-01T00:00:00.000Z");
    // year DESC first (2024 before 2020), folder ASC within a tied year
    // never applies here since years differ — this proves level ORDER
    // (year outranks folder), not a tie-break.
    const { items } = getFeedPage(db, {
      groupBy: ["year", "folder"],
      after: 10,
    });
    expect(items.map((i) => i.name)).toEqual(["y.jpg", "x.jpg"]);
  });
});

describe("getFeedPage — camera/kind dimensions", () => {
  it("groups by camera, Unknown ('') first under ASC (empty string sorts before non-empty)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b] = upsertScan(db, "/photos/trip", 1, [
      { name: "canon.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "nocam.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET camera = ? WHERE id = ?`).run(
      "Canon R6",
      a.id
    );
    const { items } = getFeedPage(db, { groupBy: ["camera"], after: 10 });
    expect(items.map((i) => i.groupValues.camera)).toEqual(["", "Canon R6"]);
  });

  it("groups by kind", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.mp4", size: 1, mtimeMs: 1, kind: "video" },
    ]);
    const { items } = getFeedPage(db, { groupBy: ["kind"], after: 10 });
    expect(items.map((i) => i.groupValues.kind)).toEqual(["image", "video"]);
  });
});

describe("getFeedPage — filter", () => {
  it("excludes rows below the rating threshold", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b, c] = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id = ?`).run(a.id);
    db.prepare(`UPDATE photos SET rating = 3 WHERE id = ?`).run(b.id);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      after: 10,
      filter: { minRating: 4 },
    });
    expect(items.map((i) => i.name)).toEqual(["a.jpg"]);
  });

  it("excludes rows by orientation (portrait only)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [land, port] = upsertScan(db, "/photos/trip", 1, [
      { name: "land.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "port.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET width = 400, height = 300 WHERE id = ?`).run(
      land.id
    );
    db.prepare(`UPDATE photos SET width = 300, height = 400 WHERE id = ?`).run(
      port.id
    );
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      after: 10,
      filter: { orientations: ["portrait"] },
    });
    expect(items.map((i) => i.name)).toEqual(["port.jpg"]);
  });

  it("collapsed-placeholder counts reflect the filter", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b] = upsertScan(db, "/photos/aaa", 1, [
      { name: "hi.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "lo.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/bbb", 1, [
      { name: "z.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id = ?`).run(a.id);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      after: 10,
      filter: { minRating: 4 },
      collapsed: [[{ dimension: "folder", value: "/photos/aaa" }]],
    });
    const ph = items.find((i) => i.collapsed);
    expect(ph.count).toBe(1);
  });

  it("applies the filter to real rows while a sibling folder is collapsed", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [ahi, alo] = upsertScan(db, "/photos/aaa", 1, [
      { name: "ahi.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "alo.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const [bhi, blo] = upsertScan(db, "/photos/bbb", 1, [
      { name: "bhi.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "blo.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/ccc", 1, [
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id IN (?, ?)`).run(
      ahi.id,
      bhi.id
    );
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      after: 10,
      filter: { minRating: 4 },
      collapsed: [[{ dimension: "folder", value: "/photos/aaa" }]],
    });
    // aaa collapsed -> placeholder with filtered count 1 (ahi); bbb real row bhi (5-star);
    // ccc has no >=4 photo so it disappears entirely.
    const ph = items.find((i) => i.collapsed);
    expect(ph.count).toBe(1);
    expect(items.filter((i) => !i.collapsed).map((i) => i.name)).toEqual([
      "bhi.jpg",
    ]);
  });

  it("nulls out focusItem when the focus photo fails the filter", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [hi, lo] = upsertScan(db, "/photos/trip", 1, [
      { name: "hi.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "lo.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id = ?`).run(hi.id);
    // focus on the 0-star lo.jpg while filtering to >=4
    const { items, focusItem } = getFeedPage(db, {
      groupBy: ["folder"],
      focusId: lo.id,
      before: 5,
      after: 5,
      filter: { minRating: 4 },
    });
    expect(focusItem).toBe(null);
    expect(items.map((i) => i.name)).not.toContain("lo.jpg");
    // a matching focus still returns its focusItem
    const r2 = getFeedPage(db, {
      groupBy: ["folder"],
      focusId: hi.id,
      after: 5,
      filter: { minRating: 4 },
    });
    expect(r2.focusItem?.name).toBe("hi.jpg");
  });
});

describe("findGroupBoundary", () => {
  it("finds the next boundary at the innermost dimension (next year, same folder)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const photos = upsertScan(db, "/photos/aaa", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "2.jpg", size: 1, mtimeMs: 2, kind: "image" },
    ]);
    setTakenAt(db, photos[0].id, "2024-01-01");
    setTakenAt(db, photos[1].id, "2023-01-01");

    const result = findGroupBoundary(db, {
      groupBy: ["folder", "year"],
      focusId: photos[0].id,
      direction: "next",
    });
    expect(result).toEqual({ id: photos[1].id });
  });

  it("rolls up to the next outer dimension once the inner one is exhausted (next folder)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const aaaPhotos = upsertScan(db, "/photos/aaa", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const bbbPhotos = upsertScan(db, "/photos/bbb", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, aaaPhotos[0].id, "2024-01-01");
    setTakenAt(db, bbbPhotos[0].id, "2023-01-01");

    const result = findGroupBoundary(db, {
      groupBy: ["folder", "year"],
      focusId: aaaPhotos[0].id,
      direction: "next",
    });
    expect(result).toEqual({ id: bbbPhotos[0].id });
  });

  it("lands on the target group's FIRST photo in the current sort, not its lowest id (#77)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const aaa = upsertScan(db, "/photos/aaa", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    // Insert order fixes id order: 1.jpg < 2.jpg < 3.jpg. Taken order is
    // shuffled so the sort-first photo is NOT the lowest id.
    const bbb = upsertScan(db, "/photos/bbb", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" }, // lowest id
      { name: "2.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "3.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, aaa[0].id, "2020-01-01");
    setTakenAt(db, bbb[0].id, "2023-03-01"); // lowest id, but latest taken
    setTakenAt(db, bbb[1].id, "2023-01-01"); // earliest taken → first shown
    setTakenAt(db, bbb[2].id, "2023-02-01");

    // Sorted by Taken ascending, bbb shows 2.jpg, 3.jpg, 1.jpg — so a jump into
    // bbb must land on 2.jpg, not the lowest-id 1.jpg.
    const next = findGroupBoundary(db, {
      groupBy: ["folder"],
      sort: { by: "date_taken", dir: "asc" },
      focusId: aaa[0].id,
      direction: "next",
    });
    expect(next).toEqual({ id: bbb[1].id });

    // The mirror image: jumping "prev" from a later group lands on the same
    // first-in-sort photo of bbb (the reseek path).
    const ccc = upsertScan(db, "/photos/ccc", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, ccc[0].id, "2025-01-01");
    const prev = findGroupBoundary(db, {
      groupBy: ["folder"],
      sort: { by: "date_taken", dir: "asc" },
      focusId: ccc[0].id,
      direction: "prev",
    });
    expect(prev).toEqual({ id: bbb[1].id });
  });

  it("returns null at the true end of the library", () => {
    const db = getDb();
    seedVolume(db, 1);
    const photos = upsertScan(db, "/photos/aaa", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, photos[0].id, "2024-01-01");

    const result = findGroupBoundary(db, {
      groupBy: ["folder", "year"],
      focusId: photos[0].id,
      direction: "next",
    });
    expect(result).toBeNull();
  });

  it("returns null at the true start of the library (direction: prev)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const photos = upsertScan(db, "/photos/aaa", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, photos[0].id, "2024-01-01");

    const result = findGroupBoundary(db, {
      groupBy: ["folder", "year"],
      focusId: photos[0].id,
      direction: "prev",
    });
    expect(result).toBeNull();
  });

  it("skips an already-collapsed section between the focus and the next real boundary", () => {
    const db = getDb();
    seedVolume(db, 1);
    const aaaPhotos = upsertScan(db, "/photos/aaa", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/bbb", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const cccPhotos = upsertScan(db, "/photos/ccc", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);

    const result = findGroupBoundary(db, {
      groupBy: ["folder"],
      collapsed: [[{ dimension: "folder", value: "/photos/bbb" }]],
      focusId: aaaPhotos[0].id,
      direction: "next",
    });
    expect(result).toEqual({ id: cccPhotos[0].id });
  });

  it("returns the FIRST row (not an arbitrary/last one) of a multi-row previous group", () => {
    const db = getDb();
    seedVolume(db, 1);
    const aaaPhotos = upsertScan(db, "/photos/aaa", 1, [
      { name: "y1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "y2-first.jpg", size: 1, mtimeMs: 2, kind: "image" },
      { name: "y2-second.jpg", size: 1, mtimeMs: 3, kind: "image" },
    ]);
    const bbbPhotos = upsertScan(db, "/photos/bbb", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    // year DESC means the LARGER year sorts first within "aaa", so the
    // group immediately adjacent to "bbb" (in true forward order) is the
    // smaller year — the two-photo one — not the single-photo one.
    setTakenAt(db, aaaPhotos[0].id, "2024-01-01");
    setTakenAt(db, aaaPhotos[1].id, "2023-01-01");
    setTakenAt(db, aaaPhotos[2].id, "2023-01-01");
    setTakenAt(db, bbbPhotos[0].id, "2022-01-01");

    const result = findGroupBoundary(db, {
      groupBy: ["folder", "year"],
      focusId: bbbPhotos[0].id,
      direction: "prev",
    });
    // y2-first has the lower id, so it sorts first within the tied
    // (folder, year) tuple once photos.id breaks the tie — walking
    // backward from "bbb" instead lands on y2-second (the higher id),
    // which is what this test guards against.
    expect(result).toEqual({ id: aaaPhotos[1].id });
  });

  it("throws for an unknown focusId", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/aaa", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    expect(() =>
      findGroupBoundary(db, {
        groupBy: ["folder"],
        focusId: 999999,
        direction: "next",
      })
    ).toThrow(/999999/);
  });
});

describe("findGroupBoundary — filter", () => {
  it("skips a next group that has no photos matching the filter", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a1] = upsertScan(db, "/photos/aaa", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/bbb", 1, [
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const [c1] = upsertScan(db, "/photos/ccc", 1, [
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id IN (?, ?)`).run(
      a1.id,
      c1.id
    );
    const res = findGroupBoundary(db, {
      groupBy: ["folder"],
      focusId: a1.id,
      direction: "next",
      filter: { minRating: 4 },
    });
    expect(res.id).toBe(c1.id);
  });
});

describe("getFeedPage — kind", () => {
  it("includes each item's kind (image vs raw)", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/mixed", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.cr2", size: 1, mtimeMs: 1, kind: "raw" },
    ]);
    const { items } = getFeedPage(db, { groupBy: ["folder"], after: 10 });
    const byName = Object.fromEntries(items.map((i) => [i.name, i.kind]));
    expect(byName).toEqual({ "a.jpg": "image", "b.cr2": "raw" });
  });
});

describe("getFeedPage — collapse-exclusion", () => {
  it("excludes photos whose prefix matches a collapsed path", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      collapsed: [[{ dimension: "folder", value: "/photos/a-folder" }]],
      after: 10,
    });
    // The real-row query still excludes a-folder's own photos (unchanged,
    // cheap) — a1.jpg never comes back as a real row. Its section now
    // surfaces as an in-place placeholder instead (see the "in-place
    // collapsed placeholder" describe block below for that behavior).
    expect(items.filter((i) => !i.collapsed).map((i) => i.name)).toEqual([
      "b1.jpg",
    ]);
  });
});

describe("getFeedPage — in-place collapsed placeholder", () => {
  it("splices a placeholder in place of a fully-collapsed leading section", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "a2.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      collapsed: [[{ dimension: "folder", value: "/photos/a-folder" }]],
      after: 10,
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      collapsed: true,
      id: "collapsed:folder=/photos/a-folder",
      path: [{ dimension: "folder", value: "/photos/a-folder" }],
      count: 2,
      groupValues: { folder: "/photos/a-folder" },
    });
    expect(items[1].name).toBe("b1.jpg");
  });

  it("splices a placeholder BETWEEN two real sections, in the right order", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/c-folder", 1, [
      { name: "c1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      collapsed: [[{ dimension: "folder", value: "/photos/b-folder" }]],
      after: 10,
    });
    expect(items.map((i) => i.name ?? i.id)).toEqual([
      "a1.jpg",
      "collapsed:folder=/photos/b-folder",
      "c1.jpg",
    ]);
  });

  it("splices multiple placeholders within one page, each in the right position", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/c-folder", 1, [
      { name: "c1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      collapsed: [
        [{ dimension: "folder", value: "/photos/a-folder" }],
        [{ dimension: "folder", value: "/photos/c-folder" }],
      ],
      after: 10,
    });
    expect(items.map((i) => i.name ?? i.id)).toEqual([
      "collapsed:folder=/photos/a-folder",
      "b1.jpg",
      "collapsed:folder=/photos/c-folder",
    ]);
  });

  it("does not splice a placeholder for a collapsed path outside the requested window", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(
      db,
      rows.find((r) => r.name === "a.jpg").id,
      "2022-01-01T00:00:00.000Z"
    );
    setTakenAt(
      db,
      rows.find((r) => r.name === "b.jpg").id,
      "2021-01-01T00:00:00.000Z"
    );
    setTakenAt(
      db,
      rows.find((r) => r.name === "c.jpg").id,
      "2020-01-01T00:00:00.000Z"
    );
    // Fetch only 2020 (year DESC, so "after" from the c.jpg focus is empty
    // in this fixture — instead fetch just after b.jpg, limit 1, so only
    // c.jpg's year is in range and 2022's collapse (unrelated, "before"
    // everything fetched) must not appear).
    const focus = rows.find((r) => r.name === "b.jpg");
    const { items } = getFeedPage(db, {
      groupBy: ["year"],
      collapsed: [[{ dimension: "year", value: "2022" }]],
      focusId: focus.id,
      after: 1,
    });
    expect(items.map((i) => i.name ?? i.id)).toEqual(["c.jpg"]);
  });

  it("splices a placeholder at the true start of the feed with no focusId", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      collapsed: [[{ dimension: "folder", value: "/photos/a-folder" }]],
      after: 10,
    });
    expect(items[0].collapsed).toBe(true);
  });

  it("splices a placeholder at the true end of the feed (fewer real rows than the limit)", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      collapsed: [[{ dimension: "folder", value: "/photos/b-folder" }]],
      after: 10, // limit far exceeds the 1 real row left after a1.jpg
    });
    expect(items.map((i) => i.name ?? i.id)).toEqual([
      "a1.jpg",
      "collapsed:folder=/photos/b-folder",
    ]);
  });

  it("orders two placeholders of DIFFERENT collapse depths correctly in one page", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const rowsB = upsertScan(db, "/photos/b-folder", 1, [
      { name: "b2020.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b2019.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(
      db,
      rowsB.find((r) => r.name === "b2020.jpg").id,
      "2020-01-01T00:00:00.000Z"
    );
    setTakenAt(
      db,
      rowsB.find((r) => r.name === "b2019.jpg").id,
      "2019-01-01T00:00:00.000Z"
    );
    // a-folder is collapsed entirely (depth 1); only b-folder's 2020 is
    // collapsed (depth 2) — the two placeholders share no common prefix
    // value, so this exercises comparing across different depths without
    // reading past either one's own known dimensions.
    const { items } = getFeedPage(db, {
      groupBy: ["folder", "year"],
      collapsed: [
        [{ dimension: "folder", value: "/photos/a-folder" }],
        [
          { dimension: "folder", value: "/photos/b-folder" },
          { dimension: "year", value: "2020" },
        ],
      ],
      after: 10,
    });
    expect(items.map((i) => i.name ?? i.id)).toEqual([
      "collapsed:folder=/photos/a-folder",
      "collapsed:folder=/photos/b-folder>year=2020",
      "b2019.jpg",
    ]);
  });
});

describe("getFeedPage — startPath (jump to an arbitrary hierarchy path)", () => {
  it("seeks to the first row at or after the given path, without a focusId", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/c-folder", 1, [
      { name: "c1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      startPath: [{ dimension: "folder", value: "/photos/b-folder" }],
      after: 10,
    });
    expect(items.map((i) => i.name)).toEqual(["b1.jpg", "c1.jpg"]);
  });

  it("is inclusive of the exact path prefix (not strictly-after)", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/only", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      startPath: [{ dimension: "folder", value: "/photos/only" }],
      after: 10,
    });
    expect(items.map((i) => i.name)).toEqual(["a.jpg"]);
  });

  it("multi-level: seeks to the EXACT subgroup, not its parent's first subgroup", () => {
    // Regression: a two-level jump (camera → kind) used an inclusive compare at
    // the camera level, so `camera >= "Canon"` swallowed all of Canon and landed
    // on Canon/image instead of the requested Canon/video.
    const db = getDb();
    seedVolume(db, 1);
    const [ci, cv, ni] = upsertScan(db, "/photos/trip", 1, [
      { name: "canon-img.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "canon-vid.mp4", size: 1, mtimeMs: 1, kind: "video" },
      { name: "nikon-img.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET camera = ? WHERE id = ?`).run("Canon", ci.id);
    db.prepare(`UPDATE photos SET camera = ? WHERE id = ?`).run("Canon", cv.id);
    db.prepare(`UPDATE photos SET camera = ? WHERE id = ?`).run("Nikon", ni.id);
    const { items } = getFeedPage(db, {
      groupBy: ["camera", "kind"],
      startPath: [
        { dimension: "camera", value: "Canon" },
        { dimension: "kind", value: "video" },
      ],
      after: 10,
    });
    // Starts AT Canon/video (skipping the earlier Canon/image), then the next
    // camera — never the parent's first subgroup.
    expect(items.map((i) => i.name)).toEqual([
      "canon-vid.mp4",
      "nikon-img.jpg",
    ]);
  });

  it("multi-level DESC (year → month): lands on the exact month, not the year's first month", () => {
    // The reported repro: group by year/month, click a month in the fisheye.
    // year & month are both DESC, so the feed reads 2025/08, 2025/07, 2025/06…
    // A jump to 2025/07 must skip 2025/08 (the year's first month) and start AT
    // 2025/07.
    const db = getDb();
    seedVolume(db, 1);
    // upsertScan returns rows ORDER BY filename, not input order — so assign
    // taken_at by looking each photo up by name, not by array position.
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "aug.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "jul.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "jun.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "dec24.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.id]));
    const setTaken = db.prepare(`UPDATE photos SET taken_at = ? WHERE id = ?`);
    setTaken.run(Date.UTC(2025, 7, 15), byName["aug.jpg"]); // 2025-08
    setTaken.run(Date.UTC(2025, 6, 15), byName["jul.jpg"]); // 2025-07
    setTaken.run(Date.UTC(2025, 5, 15), byName["jun.jpg"]); // 2025-06
    setTaken.run(Date.UTC(2024, 11, 15), byName["dec24.jpg"]); // 2024-12
    const { items } = getFeedPage(db, {
      groupBy: ["year", "month"],
      startPath: [
        { dimension: "year", value: "2025" },
        { dimension: "month", value: "07" },
      ],
      after: 10,
    });
    expect(items.map((i) => i.name)).toEqual([
      "jul.jpg",
      "jun.jpg",
      "dec24.jpg",
    ]);
  });
});

describe("getFeedPage — keyset pagination", () => {
  it("fetches the first N rows when no focusId is given", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, { groupBy: ["folder"], after: 2 });
    expect(items.map((i) => i.name)).toEqual(["a.jpg", "b.jpg"]);
  });

  it("fetches rows after a focusId, in order", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const focus = rows.find((r) => r.name === "a.jpg");
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      focusId: focus.id,
      after: 10,
    });
    expect(items.map((i) => i.name)).toEqual(["b.jpg", "c.jpg"]);
  });

  it("fetches rows before a focusId, in order (not reversed)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const focus = rows.find((r) => r.name === "c.jpg");
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      focusId: focus.id,
      before: 10,
      after: 0,
    });
    expect(items.map((i) => i.name)).toEqual(["a.jpg", "b.jpg"]);
  });

  it("fetches both before and after a focusId in one call", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "d.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const focus = rows.find((r) => r.name === "b.jpg");
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      focusId: focus.id,
      before: 1,
      after: 10,
    });
    expect(items.map((i) => i.name)).toEqual(["a.jpg", "c.jpg", "d.jpg"]);
  });

  it("respects mixed-direction ordering when seeking (year DESC)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "y2024.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "y2022.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "y2020.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    // upsertScan returns rows ordered by filename, not insertion order, so
    // look up each row by name rather than destructuring by position —
    // positional indexing here would silently assign the wrong taken_at to
    // the wrong file (alphabetical order reverses the insertion order).
    setTakenAt(
      db,
      rows.find((r) => r.name === "y2024.jpg").id,
      "2024-01-01T00:00:00.000Z"
    );
    setTakenAt(
      db,
      rows.find((r) => r.name === "y2022.jpg").id,
      "2022-01-01T00:00:00.000Z"
    );
    setTakenAt(
      db,
      rows.find((r) => r.name === "y2020.jpg").id,
      "2020-01-01T00:00:00.000Z"
    );
    const middleFocus = rows.find((r) => r.name === "y2022.jpg");
    const { items } = getFeedPage(db, {
      groupBy: ["year"],
      focusId: middleFocus.id,
      after: 10,
    });
    // "after" in year-DESC order means an EARLIER year.
    expect(items.map((i) => i.name)).toEqual(["y2020.jpg"]);
  });
});

describe("getFeedPage — focusItem", () => {
  it("returns the focus photo's own row, with groupValues under the current groupBy", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rowsA = upsertScan(db, "/photos/b-folder", 1, [
      { name: "x.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const rowsB = upsertScan(db, "/photos/a-folder", 1, [
      { name: "y.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, rowsA[0].id, "2020-01-01T00:00:00.000Z");
    setTakenAt(db, rowsB[0].id, "2024-01-01T00:00:00.000Z");
    const focus = rowsA.find((r) => r.name === "x.jpg");
    const { focusItem } = getFeedPage(db, {
      groupBy: ["year", "folder"],
      focusId: focus.id,
      after: 10,
    });
    expect(focusItem).not.toBeNull();
    expect(focusItem.id).toBe(focus.id);
    expect(focusItem.name).toBe("x.jpg");
    expect(focusItem.groupValues).toEqual({
      year: "2020",
      folder: "/photos/b-folder",
    });
  });

  it("returns null focusItem when no focusId is given", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { focusItem } = getFeedPage(db, { groupBy: ["folder"], after: 10 });
    expect(focusItem).toBeNull();
  });
});

describe("photoIdsMatchingFilter", () => {
  it("returns all non-stale photo ids with no filter", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const ids = photoIdsMatchingFilter(db);
    expect(ids.sort((a, b) => a - b)).toEqual(
      rows.map((r) => r.id).sort((a, b) => a - b)
    );
  });

  it("respects a minRating filter", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b] = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id = ?`).run(a.id);
    const ids = photoIdsMatchingFilter(db, { minRating: 4 });
    expect(ids).toEqual([a.id]);
  });

  it("excludes stale photos", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b] = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]); // b.jpg no longer scanned -> stale
    const ids = photoIdsMatchingFilter(db);
    expect(ids).toEqual([a.id]);
  });

  it("scopes to one group via a path (per-group select)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a] = upsertScan(db, "/photos/aaa", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const bbb = upsertScan(db, "/photos/bbb", 1, [
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const ids = photoIdsMatchingFilter(db, {}, [
      { dimension: "folder", value: "/photos/bbb" },
    ]);
    expect(ids.sort((x, y) => x - y)).toEqual(
      bbb.map((r) => r.id).sort((x, y) => x - y)
    );
    expect(ids).not.toContain(a.id);
  });

  it("throws on an unknown dimension in the group path", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/aaa", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    expect(() =>
      photoIdsMatchingFilter(db, {}, [{ dimension: "bogus", value: "x" }])
    ).toThrow();
  });

  it("scopes a date group by the sort's date column, matching the feed (issue #71)", () => {
    const db = getDb();
    seedVolume(db, 1);
    // Both photos are CREATED (btime) in different years but carry no EXIF
    // taken_at — exactly the shape of the SD-card-copy files that exposed the
    // bug: the feed groups by created-year, keep-only scoped by taken_at.
    const [a, b] = upsertScan(db, "/photos/trip", 1, [
      {
        name: "a.jpg",
        size: 1,
        mtimeMs: 1,
        btimeMs: 1497484800000,
        kind: "image",
      }, // 2017
      {
        name: "b.jpg",
        size: 1,
        mtimeMs: 1,
        btimeMs: 1592179200000,
        kind: "image",
      }, // 2020
    ]);
    markExifRead(db, a.id); // both were read; neither had an EXIF date
    markExifRead(db, b.id);
    const sort = { by: "date_created", dir: "desc" };
    // Grouped by created-year the feed puts a in 2017; the id set must agree.
    expect(
      photoIdsMatchingFilter(
        db,
        {},
        [{ dimension: "year", value: "2017" }],
        sort
      )
    ).toEqual([a.id]);
    // And it must exclude the other created-year, not leak b.
    expect(
      photoIdsMatchingFilter(
        db,
        {},
        [{ dimension: "year", value: "2020" }],
        sort
      )
    ).toEqual([b.id]);
    // These files have no EXIF, so the taken date FALLS BACK to the file's
    // creation date: a taken-date path now finds them under their created year
    // instead of dumping both into Unknown, which is the point of the fallback.
    expect(
      photoIdsMatchingFilter(db, {}, [{ dimension: "year", value: "2017" }])
    ).toEqual([a.id]);
  });
});

describe("photoCountMatchingFilter", () => {
  it("counts all non-stale photos with no filter (library total)", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    expect(photoCountMatchingFilter(db)).toBe(3);
  });

  it("counts only matches under a filter (the 'showing' count)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b, c] = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id IN (?, ?)`).run(
      a.id,
      b.id
    );
    expect(photoCountMatchingFilter(db, { minRating: 4 })).toBe(2);
    expect(photoCountMatchingFilter(db)).toBe(3);
  });
});

describe("workingSetTimeline — album gap-clustering source", () => {
  it("returns photos time-ascending by taken_at (mtime fallback)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b, c] = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 300, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 100, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 200, kind: "image" },
    ]);
    // b has an explicit taken_at that reorders it after a's mtime.
    setTakenAt(db, b.id, "2020-01-01T00:00:10.000Z");
    const { photos, truncated } = workingSetTimeline(db);
    expect(truncated).toBe(false);
    // c(mtime 200), a(mtime 300), b(taken_at 2020…) — ascending by t.
    expect(photos.map((p) => p.id)).toEqual([c.id, a.id, b.id]);
    expect(photos.every((p) => typeof p.t === "number")).toBe(true);
    expect(photos.map((p) => p.mtimeMs)).toEqual([200, 300, 100]);
  });

  it("respects a filter spec (minRating narrows the working set)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b, c] = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 2, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 3, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id IN (?, ?)`).run(
      a.id,
      c.id
    );
    const { photos } = workingSetTimeline(db, { minRating: 4 });
    expect(photos.map((p) => p.id).sort()).toEqual([a.id, c.id].sort());
  });

  it("sets truncated=true and caps at the limit", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(
      db,
      "/photos/many",
      1,
      Array.from({ length: 5 }, (_, i) => ({
        name: `p${i}.jpg`,
        size: 1,
        mtimeMs: i + 1,
        kind: "image",
      }))
    );
    const { photos, truncated } = workingSetTimeline(db, {}, 3);
    expect(photos).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  // Regression guard, not a bug hunt: workingSetTimeline has no media-kind
  // filter today, so videos already join the album timeline alongside
  // images. This test just pins that "videos join albums" user story so a
  // future filter addition can't silently drop them.
  it("includes videos alongside images in the timeline", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [img, vid] = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 100, kind: "image" },
      { name: "b.mp4", size: 1, mtimeMs: 200, kind: "video" },
    ]);
    const { photos } = workingSetTimeline(db);
    expect(photos.map((p) => p.id)).toEqual(
      expect.arrayContaining([img.id, vid.id])
    );
  });
});

describe("getFeedPage — photo-level sort", () => {
  it("sorts a flat feed (no groupBy) by rating desc, id-tiebroken", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b, c] = upsertScan(db, "/p", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 2, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 3, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id = ?`).run(b.id);
    db.prepare(`UPDATE photos SET rating = 3 WHERE id = ?`).run(c.id);
    const { items } = getFeedPage(db, {
      groupBy: [],
      after: 10,
      sort: { by: "rating", dir: "desc" },
    });
    expect(items.map((i) => i.id)).toEqual([b.id, c.id, a.id]);
  });

  it("sorts within a group by name asc without changing group order", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/p", 1, [
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "a.jpg", size: 1, mtimeMs: 2, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 3, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      after: 10,
      sort: { by: "name", dir: "asc" },
    });
    expect(items.map((i) => i.name)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  });

  it("keeps before/after paging stable around a focus under a non-default sort", () => {
    const db = getDb();
    seedVolume(db, 1);
    const ids = upsertScan(
      db,
      "/p",
      1,
      Array.from({ length: 6 }, (_, i) => ({
        name: `p${i}.jpg`,
        size: (i % 3) + 1, // sizes 1,2,3,1,2,3
        mtimeMs: i + 1,
        kind: "image",
      }))
    );
    const focus = ids[3].id;
    const { items, focusItem } = getFeedPage(db, {
      groupBy: [],
      focusId: focus,
      before: 2,
      after: 2,
      sort: { by: "size", dir: "asc" },
    });
    // getFeedPage's established contract (see "fetches both before and after
    // a focusId in one call" above) is that `items` never includes the focus
    // row itself — it's returned separately as `focusItem` — so the window's
    // anchor is verified there, not in `items`.
    expect(focusItem?.id).toBe(focus);
    // window is contiguous in size-asc,id-asc order around the focus
    const sizes = items.map((i) => i.size);
    expect([...sizes]).toEqual([...sizes].sort((x, y) => x - y));
  });
});

describe("workingSetTimes — timeline density", () => {
  function seedTimes(db, isoList) {
    seedVolume(db, 1);
    const rows = upsertScan(
      db,
      "/photos/trip",
      1,
      isoList.map((_, i) => ({
        name: `p${i}.jpg`,
        size: 1,
        mtimeMs: 1000 + i,
        kind: "image",
      }))
    );
    isoList.forEach((iso, i) => iso && setTakenAt(db, rows[i].id, iso));
    return rows;
  }

  it("returns sorted t = COALESCE(taken_at, mtime) with exact min/max/total", () => {
    const db = getDb();
    seedTimes(db, [
      "2023-03-01T00:00:00.000Z",
      "2023-01-01T00:00:00.000Z",
      "2023-02-01T00:00:00.000Z",
    ]);
    const r = workingSetTimes(db, {});
    expect(r.total).toBe(3);
    expect(r.sampled).toBe(false);
    expect(r.times).toEqual([...r.times].sort((a, b) => a - b));
    expect(r.min).toBe(Date.parse("2023-01-01T00:00:00.000Z"));
    expect(r.max).toBe(Date.parse("2023-03-01T00:00:00.000Z"));
  });

  it("falls back to mtime when taken_at is null", () => {
    const db = getDb();
    seedTimes(db, [null]); // mtimeMs 1000
    const r = workingSetTimes(db, {});
    expect(r.total).toBe(1);
    expect(r.min).toBe(1000);
    expect(r.max).toBe(1000);
  });

  it("respects a rating facet (crossfilter on other dims)", () => {
    const db = getDb();
    const rows = seedTimes(db, [
      "2023-01-01T00:00:00.000Z",
      "2023-02-01T00:00:00.000Z",
      "2023-03-01T00:00:00.000Z",
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id = ?`).run(rows[1].id);
    const r = workingSetTimes(db, { minRating: 4 });
    expect(r.total).toBe(1);
    expect(r.min).toBe(Date.parse("2023-02-01T00:00:00.000Z"));
  });

  it("IGNORES an incoming time facet (density spans the whole range you brush within)", () => {
    const db = getDb();
    seedTimes(db, [
      "2023-01-01T00:00:00.000Z",
      "2023-02-01T00:00:00.000Z",
      "2023-03-01T00:00:00.000Z",
    ]);
    const withRange = workingSetTimes(db, {
      dateFrom: Date.parse("2023-02-15T00:00:00.000Z"),
      dateTo: Date.parse("2023-02-20T00:00:00.000Z"),
    });
    expect(withRange.total).toBe(3); // time facet stripped
    expect(withRange.min).toBe(Date.parse("2023-01-01T00:00:00.000Z"));
  });

  it("even-stride down-samples above the cap but keeps total exact and pins the max", () => {
    const db = getDb();
    seedTimes(db, [
      "2023-01-01T00:00:00.000Z",
      "2023-01-02T00:00:00.000Z",
      "2023-01-03T00:00:00.000Z",
      "2023-01-04T00:00:00.000Z",
      "2023-01-05T00:00:00.000Z",
    ]);
    const r = workingSetTimes(db, {}, 2);
    expect(r.total).toBe(5); // exact, not the sample size
    expect(r.sampled).toBe(true);
    expect(r.times.length).toBeLessThanOrEqual(3); // 2 strided + pinned max
    expect(r.times[r.times.length - 1]).toBe(r.max);
    expect(r.times[0]).toBe(r.min);
  });

  it("empty working set → nulls", () => {
    const db = getDb();
    seedVolume(db, 1);
    expect(workingSetTimes(db, {})).toEqual({
      times: [],
      total: 0,
      min: null,
      max: null,
      sampled: false,
    });
  });
});

describe("folderPath focus scope — subtree matching", () => {
  function seedTree(db) {
    seedVolume(db, 1);
    upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/trip/day1", 1, [
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/trip-2", 1, [
      { name: "sibling.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/other", 1, [
      { name: "d.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
  }

  it("counts the folder plus its subfolders, excluding siblings", () => {
    const db = getDb();
    seedTree(db);
    // /photos/trip (2) + /photos/trip/day1 (1) = 3; NOT /photos/trip-2 or /other.
    expect(photoCountMatchingFilter(db, { folderPath: "/photos/trip" })).toBe(
      3
    );
    // Whole library is unscoped.
    expect(photoCountMatchingFilter(db, {})).toBe(5);
  });

  it("the feed grid returns only subtree rows", () => {
    const db = getDb();
    seedTree(db);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      filter: { folderPath: "/photos/trip" },
      after: 100,
    });
    expect(items.map((i) => i.name).sort()).toEqual([
      "a.jpg",
      "b.jpg",
      "c.jpg",
    ]);
    expect(new Set(items.map((i) => i.groupValues.folder))).toEqual(
      new Set(["/photos/trip", "/photos/trip/day1"])
    );
  });

  it("focuses a bare parent that has no media of its own (only the LIKE arm matches)", () => {
    const db = getDb();
    seedVolume(db, 1);
    // /albums has no media directly — only nested folders do.
    upsertScan(db, "/albums/2024/jan", 1, [
      { name: "x.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/albums/2024/feb", 1, [
      { name: "y.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    expect(photoCountMatchingFilter(db, { folderPath: "/albums" })).toBe(2);
    expect(
      photoCountMatchingFilter(db, { folderPath: "/albums/2024/jan" })
    ).toBe(1);
  });

  it("intersects folderPath with other facets (AND semantics)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "keep.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "skip.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id = ?`).run(rows[0].id);
    expect(
      photoCountMatchingFilter(db, { folderPath: "/photos/trip", minRating: 5 })
    ).toBe(1);
  });
});
