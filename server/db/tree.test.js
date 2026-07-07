import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { getTreeNode } from "./tree.js";

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
