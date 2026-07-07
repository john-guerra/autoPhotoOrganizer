import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { getFeedPage } from "./feed.js";

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
    expect(items.map((i) => i.name)).toEqual(["b1.jpg"]);
  });
});

describe("getFeedPage — collapsed section summaries", () => {
  it("returns a count for each collapsed path", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "a2.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { sections } = getFeedPage(db, {
      groupBy: ["folder"],
      collapsed: [[{ dimension: "folder", value: "/photos/a-folder" }]],
      after: 10,
    });
    expect(sections).toEqual([
      {
        path: [{ dimension: "folder", value: "/photos/a-folder" }],
        count: 2,
      },
    ]);
  });

  it("returns an empty sections array when nothing is collapsed", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { sections } = getFeedPage(db, { groupBy: ["folder"], after: 10 });
    expect(sections).toEqual([]);
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
