import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { getFeedPage, findGroupBoundary } from "./feed.js";

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

  it("sorts photos with no taken_at into an Unknown bucket, last", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [known, unknown] = upsertScan(db, "/photos/trip", 1, [
      { name: "known.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "unknown.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, known.id, "2020-01-01T00:00:00.000Z");
    // unknown.jpg keeps taken_at = NULL.
    const { items } = getFeedPage(db, { groupBy: ["year"], after: 10 });
    expect(items.map((i) => i.name)).toEqual(["known.jpg", "unknown.jpg"]);
    expect(items[1].groupValues.year).toBe("");
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
