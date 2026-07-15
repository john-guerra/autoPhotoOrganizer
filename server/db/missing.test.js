import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan, setPhotoRating } from "./photos.js";
import { sameFileCandidates } from "./missing.js";

let cacheDir;
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-missing-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  const db = getDb();
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (1, 'vol-a', 'uuid-a', '/a', ?)`
  ).run(Date.now());
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (2, 'vol-b', 'uuid-b', '/b', ?)`
  ).run(Date.now());
});
afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

const F = { name: "IMG_1.jpg", size: 100, mtimeMs: 1000, kind: "image" };

function rowFor(db, id) {
  return db
    .prepare(
      "SELECT id, content_hash, filename, size, mtime FROM photos WHERE id = ?"
    )
    .get(id);
}

describe("sameFileCandidates", () => {
  it("matches an identical file in another folder by (filename,size,mtime)", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    const [b] = upsertScan(db, "/b/backup", 2, [F]);
    const cands = sameFileCandidates(db, rowFor(db, a.id));
    expect(cands.map((c) => c.id)).toEqual([b.id]);
    expect(cands[0]).toMatchObject({ absPath: "/b/backup", volumeId: 2 });
  });

  it("does not match a different file", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    upsertScan(db, "/b/other", 2, [{ ...F, name: "OTHER.jpg" }]);
    expect(sameFileCandidates(db, rowFor(db, a.id))).toEqual([]);
  });
});
