import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { getBackupCoverage, getUnbackedUpPhotos } from "./backupCoverage.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-db-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  const db = getDb();
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (1, 'test-volume-1', 'test-uuid-1', '/test1', ?)`
  ).run(Date.now());
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (2, 'test-volume-2', 'test-uuid-2', '/test2', ?)`
  ).run(Date.now());
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

function withHash(db, id, hash) {
  db.prepare("UPDATE photos SET content_hash = ? WHERE id = ?").run(hash, id);
}

describe("getBackupCoverage", () => {
  it("finds another volume holding the same content hash", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/drive1/trip", 1, [
      { name: "x.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const [b] = upsertScan(db, "/drive2/backup/trip", 2, [
      { name: "x.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    withHash(db, a.id, "sharedhash");
    withHash(db, b.id, "sharedhash");

    expect(getBackupCoverage(db, a.id).volumeIds.sort()).toEqual([1, 2]);
  });

  it("returns no other volumes when the hash is unique", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/drive1/trip", 1, [
      { name: "x.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    withHash(db, a.id, "onlyhere");
    expect(getBackupCoverage(db, a.id).volumeIds).toEqual([1]);
  });

  it("returns an empty list when the hash is not yet computed", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/drive1/trip", 1, [
      { name: "x.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    expect(getBackupCoverage(db, a.id).volumeIds).toEqual([]);
  });
});

describe("getUnbackedUpPhotos", () => {
  it("lists photos on a volume with no matching hash elsewhere", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/drive1/trip", 1, [
      { name: "unique.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const [b] = upsertScan(db, "/drive1/trip2", 1, [
      { name: "backed-up.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const [c] = upsertScan(db, "/drive2/backup", 2, [
      { name: "backed-up-copy.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    withHash(db, a.id, "onlyondrive1");
    withHash(db, b.id, "sharedhash");
    withHash(db, c.id, "sharedhash");

    const result = getUnbackedUpPhotos(db, 1);
    expect(result.map((r) => r.filename)).toEqual(["unique.jpg"]);
  });
});
