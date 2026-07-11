import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { getTreeNode, getFlatTree } from "./tree.js";

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

describe("getTreeNode — root level", () => {
  it("returns the whole library's total and top-level nodes with counts", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "a2.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { total, nodes } = getTreeNode(db, { groupBy: ["folder", "year"] });
    expect(total).toBe(3);
    expect(nodes).toEqual([
      {
        value: "/photos/a-folder",
        label: "/photos/a-folder",
        count: 2,
        hasChildren: true,
      },
      {
        value: "/photos/b-folder",
        label: "/photos/b-folder",
        count: 1,
        hasChildren: true,
      },
    ]);
  });

  it("marks hasChildren false at the deepest grouping level", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/only", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { nodes } = getTreeNode(db, { groupBy: ["folder"] });
    expect(nodes[0].hasChildren).toBe(false);
  });
});

describe("getTreeNode — nested path", () => {
  it("scopes counts to the given path prefix", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "old.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "new1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "new2.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(
      db,
      rows.find((r) => r.name === "old.jpg").id,
      "2020-01-01T00:00:00.000Z"
    );
    setTakenAt(
      db,
      rows.find((r) => r.name === "new1.jpg").id,
      "2024-01-01T00:00:00.000Z"
    );
    setTakenAt(
      db,
      rows.find((r) => r.name === "new2.jpg").id,
      "2024-01-01T00:00:00.000Z"
    );
    const { nodes } = getTreeNode(db, {
      groupBy: ["folder", "year"],
      path: [{ dimension: "folder", value: "/photos/trip" }],
    });
    expect(nodes).toEqual([
      { value: "2024", label: "2024", count: 2, hasChildren: false },
      { value: "2020", label: "2020", count: 1, hasChildren: false },
    ]);
  });

  it("formats the empty-string date sentinel as Unknown", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/trip", 1, [
      { name: "noexif.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { nodes } = getTreeNode(db, {
      groupBy: ["folder", "year"],
      path: [{ dimension: "folder", value: "/photos/trip" }],
    });
    expect(nodes).toEqual([
      { value: "", label: "Unknown", count: 1, hasChildren: false },
    ]);
  });

  it("throws when path is already at the deepest grouping level", () => {
    const db = getDb();
    seedVolume(db, 1);
    expect(() =>
      getTreeNode(db, {
        groupBy: ["folder"],
        path: [{ dimension: "folder", value: "/x" }],
      })
    ).toThrow(/deepest/);
  });

  it("throws when a path dimension doesn't match groupBy's order", () => {
    const db = getDb();
    seedVolume(db, 1);
    expect(() =>
      getTreeNode(db, {
        groupBy: ["folder", "year"],
        path: [{ dimension: "year", value: "2020" }],
      })
    ).toThrow(/dimension mismatch/);
  });
});

describe("getFlatTree", () => {
  it("orders single-dimension leaves by folder abs_path ASC with counts", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "a2.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { total, leaves } = getFlatTree(db, { groupBy: ["folder"] });
    expect(total).toBe(3);
    expect(leaves).toEqual([
      { values: { folder: "/photos/a-folder" }, count: 2 },
      { values: { folder: "/photos/b-folder" }, count: 1 },
    ]);
  });

  it("returns one leaf per (folder, year) combo, ordered folder ASC then year DESC", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rowsA = upsertScan(db, "/photos/a-folder", 1, [
      { name: "old.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "new.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(
      db,
      rowsA.find((r) => r.name === "old.jpg").id,
      "2020-01-01T00:00:00.000Z"
    );
    setTakenAt(
      db,
      rowsA.find((r) => r.name === "new.jpg").id,
      "2024-01-01T00:00:00.000Z"
    );
    const rowsB = upsertScan(db, "/photos/b-folder", 1, [
      { name: "one.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(
      db,
      rowsB.find((r) => r.name === "one.jpg").id,
      "2022-01-01T00:00:00.000Z"
    );

    const { total, leaves } = getFlatTree(db, {
      groupBy: ["folder", "year"],
    });
    expect(total).toBe(3);
    expect(leaves).toEqual([
      { values: { folder: "/photos/a-folder", year: "2024" }, count: 1 },
      { values: { folder: "/photos/a-folder", year: "2020" }, count: 1 },
      { values: { folder: "/photos/b-folder", year: "2022" }, count: 1 },
    ]);
  });

  it("orders year/month/day leaves DESC/DESC/DESC and carries all three values", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "d1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "d2.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(
      db,
      rows.find((r) => r.name === "d1.jpg").id,
      "2023-05-10T00:00:00.000Z"
    );
    setTakenAt(
      db,
      rows.find((r) => r.name === "d2.jpg").id,
      "2024-01-02T00:00:00.000Z"
    );

    const { leaves } = getFlatTree(db, {
      groupBy: ["year", "month", "day"],
    });
    // month is month-of-year ("%m") now; day stays full ISO date.
    expect(leaves).toEqual([
      {
        values: { year: "2024", month: "01", day: "2024-01-02" },
        count: 1,
      },
      {
        values: { year: "2023", month: "05", day: "2023-05-10" },
        count: 1,
      },
    ]);
  });

  it("keeps the empty-string date sentinel unformatted for a photo with NULL taken_at", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/trip", 1, [
      { name: "noexif.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { leaves } = getFlatTree(db, {
      groupBy: ["folder", "year"],
    });
    expect(leaves).toEqual([
      { values: { folder: "/photos/trip", year: "" }, count: 1 },
    ]);
  });

  it("month-of-year: aggregates the same month across years into one node, labeled by name", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    // Two Decembers (different years) + one March.
    setTakenAt(db, rows[0].id, "2002-12-10T00:00:00.000Z");
    setTakenAt(db, rows[1].id, "2019-12-24T00:00:00.000Z");
    setTakenAt(db, rows[2].id, "2010-03-05T00:00:00.000Z");

    const { nodes } = getTreeNode(db, { groupBy: ["month"] });
    // Both Decembers collapse into one "12" node with count 2; DESC order.
    expect(nodes).toEqual([
      { value: "12", label: "December", count: 2, hasChildren: false },
      { value: "03", label: "March", count: 1, hasChildren: false },
    ]);
  });
});

describe("getTreeNode/getFlatTree — filter", () => {
  it("omits groups with no photos matching the filter and filters total", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a1] = upsertScan(db, "/photos/aaa", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/bbb", 1, [
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id = ?`).run(a1.id);

    const node = getTreeNode(db, {
      groupBy: ["folder"],
      filter: { minRating: 4 },
    });
    expect(node.total).toBe(1);
    expect(node.nodes.map((n) => n.value)).toEqual(["/photos/aaa"]);

    const flat = getFlatTree(db, {
      groupBy: ["folder"],
      filter: { minRating: 4 },
    });
    expect(flat.total).toBe(1);
    expect(flat.leaves.map((l) => l.values.folder)).toEqual(["/photos/aaa"]);
  });

  it("defaults to no filter (both folders present)", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/aaa", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/bbb", 1, [
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const node = getTreeNode(db, { groupBy: ["folder"] });
    expect(node.total).toBe(2);
    expect(node.nodes.map((n) => n.value)).toEqual([
      "/photos/aaa",
      "/photos/bbb",
    ]);
  });
});

describe("getFlatTree — date-source coupling", () => {
  it("orders month groups by the sort direction (date_taken asc → ascending)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b] = upsertScan(db, "/p", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 2, kind: "image" },
    ]);
    setTakenAt(db, a.id, "2020-03-15T00:00:00Z");
    setTakenAt(db, b.id, "2020-01-15T00:00:00Z");
    const asc = getFlatTree(db, {
      groupBy: ["month"],
      sort: { by: "date_taken", dir: "asc" },
    });
    const values = asc.leaves.map((l) => l.values.month);
    expect(values).toEqual([...values].sort()); // ascending
  });
});
