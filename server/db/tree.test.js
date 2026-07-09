import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { getTreeNode, getFlatTree } from "./tree.js";

let cacheDir;
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-tree-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});
afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});
function seedVolume(db, id) {
  db.prepare(`INSERT INTO volumes (id, label) VALUES (?, ?)`).run(id, `vol${id}`);
}

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

    const node = getTreeNode(db, { groupBy: ["folder"], filter: { minRating: 4 } });
    expect(node.total).toBe(1);
    expect(node.nodes.map((n) => n.value)).toEqual(["/photos/aaa"]);

    const flat = getFlatTree(db, { groupBy: ["folder"], filter: { minRating: 4 } });
    expect(flat.total).toBe(1);
    expect(flat.leaves.map((l) => l.values.folder)).toEqual(["/photos/aaa"]);
  });

  it("defaults to no filter (both folders present)", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/aaa", 1, [{ name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" }]);
    upsertScan(db, "/photos/bbb", 1, [{ name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" }]);
    const node = getTreeNode(db, { groupBy: ["folder"] });
    expect(node.total).toBe(2);
    expect(node.nodes.map((n) => n.value)).toEqual(["/photos/aaa", "/photos/bbb"]);
  });
});
