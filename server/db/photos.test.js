import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import {
  upsertScan,
  getPhotoById,
  setPhotoRating,
  setPhotoCover,
  deleteFolder,
} from "./photos.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-db-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  const db = getDb();
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (1, 'test-volume', 'test-uuid-1', '/test', ?)`
  ).run(Date.now());
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

const FILES = [
  { name: "a.jpg", size: 100, mtimeMs: 1000, kind: "image" },
  { name: "b.jpg", size: 200, mtimeMs: 2000, kind: "image" },
];

describe("upsertScan", () => {
  it("inserts new photos sorted by filename", () => {
    const db = getDb();
    const rows = upsertScan(db, "/photos/trip", 1, FILES);
    expect(rows.map((r) => r.name)).toEqual(["a.jpg", "b.jpg"]);
    expect(rows[0]).toMatchObject({
      name: "a.jpg",
      size: 100,
      mtimeMs: 1000,
      rating: 0,
      preferredCover: 0,
    });
    expect(Number.isInteger(rows[0].id)).toBe(true);
  });

  it("is idempotent: rescanning unchanged files keeps the same ids", () => {
    const db = getDb();
    const first = upsertScan(db, "/photos/trip", 1, FILES);
    const second = upsertScan(db, "/photos/trip", 1, FILES);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });

  it("preserves content_hash when a file is unchanged, clears it when changed", () => {
    const db = getDb();
    const [first] = upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    db.prepare("UPDATE photos SET content_hash = ? WHERE id = ?").run(
      "deadbeef",
      first.id
    );

    // Rescan unchanged: hash survives.
    upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    expect(getPhotoById(db, first.id).content_hash).toBe("deadbeef");

    // Rescan with a changed size: hash is cleared.
    upsertScan(db, "/photos/trip", 1, [{ ...FILES[0], size: 999 }]);
    expect(getPhotoById(db, first.id).content_hash).toBeNull();
  });

  it("marks a file no longer present as stale instead of deleting it", () => {
    const db = getDb();
    const rows = upsertScan(db, "/photos/trip", 1, FILES);
    const bId = rows.find((r) => r.name === "b.jpg").id;

    upsertScan(db, "/photos/trip", 1, [FILES[0]]); // b.jpg no longer scanned

    const stale = db.prepare("SELECT stale FROM photos WHERE id = ?").get(bId);
    expect(stale.stale).toBe(1);
    // Excluded from the non-stale result set:
    const rescan = upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    expect(rescan.map((r) => r.name)).toEqual(["a.jpg"]);
  });

  it("reuses the same folder row across scans of the same path", () => {
    const db = getDb();
    upsertScan(db, "/photos/trip", 1, FILES);
    upsertScan(db, "/photos/trip", 1, FILES);
    const count = db.prepare("SELECT COUNT(*) AS c FROM folders").get().c;
    expect(count).toBe(1);
  });
});

describe("getPhotoById", () => {
  it("returns the row with a computed absolute path", () => {
    const db = getDb();
    const [row] = upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    const photo = getPhotoById(db, row.id);
    expect(photo.path).toBe(join("/photos/trip", "a.jpg"));
    expect(photo.filename).toBe("a.jpg");
  });

  it("returns undefined for an unknown id", () => {
    const db = getDb();
    expect(getPhotoById(db, 9999)).toBeUndefined();
  });
});

describe("setPhotoRating / setPhotoCover", () => {
  it("updates rating and preferred_cover on the photo row", () => {
    const db = getDb();
    const [row] = upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    setPhotoRating(db, row.id, 4);
    setPhotoCover(db, row.id, true);
    const photo = getPhotoById(db, row.id);
    expect(photo.rating).toBe(4);
    expect(photo.preferred_cover).toBe(1);
  });
});

describe("deleteFolder", () => {
  it("removes the folder and its photos, leaving other folders untouched", () => {
    const db = getDb();
    upsertScan(db, "/a", 1, [
      { name: "1.jpg", size: 10, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/b", 1, [
      { name: "2.jpg", size: 20, mtimeMs: 2, kind: "image" },
    ]);
    const folderAId = db
      .prepare(`SELECT id FROM folders WHERE abs_path = '/a'`)
      .get().id;

    const removed = deleteFolder(db, folderAId);
    expect(removed).toBe(true);

    expect(
      db.prepare(`SELECT * FROM folders WHERE id = ?`).get(folderAId)
    ).toBeUndefined();
    expect(
      db.prepare(`SELECT * FROM photos WHERE folder_id = ?`).all(folderAId)
    ).toEqual([]);

    // /b is untouched
    const folderBRow = db
      .prepare(`SELECT id FROM folders WHERE abs_path = '/b'`)
      .get();
    expect(folderBRow).toBeDefined();
    expect(
      db.prepare(`SELECT filename FROM photos WHERE folder_id = ?`).all(folderBRow.id)
    ).toEqual([{ filename: "2.jpg" }]);
  });

  it("returns false for an unknown folder id", () => {
    const db = getDb();
    expect(deleteFolder(db, 999999)).toBe(false);
  });
});
