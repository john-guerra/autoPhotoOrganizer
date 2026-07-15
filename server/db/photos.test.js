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
  deleteFolderSubtree,
  resetLibrary,
  repointPhoto,
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

  it("stamps first_seen_at on insert and never changes it on rescan", () => {
    const db = getDb();
    const [first] = upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    const seen1 = db
      .prepare("SELECT first_seen_at FROM photos WHERE id = ?")
      .get(first.id).first_seen_at;
    expect(Number.isInteger(seen1)).toBe(true);
    // Rescan the same unchanged file: first_seen_at must be stable.
    upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    const seen2 = db
      .prepare("SELECT first_seen_at FROM photos WHERE id = ?")
      .get(first.id).first_seen_at;
    expect(seen2).toBe(seen1);
  });

  it("clears a dismissed tombstone when the same file reappears, keeping its rating", () => {
    const db = getDb();
    const [p] = upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    setPhotoRating(db, p.id, 5);
    db.prepare("UPDATE photos SET stale = 1, dismissed = 1 WHERE id = ?").run(
      p.id
    );
    // The file comes back on a later scan of the same folder.
    upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    const row = db
      .prepare("SELECT stale, dismissed, rating FROM photos WHERE id = ?")
      .get(p.id);
    expect(row).toMatchObject({ stale: 0, dismissed: 0, rating: 5 });
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
      db
        .prepare(`SELECT filename FROM photos WHERE folder_id = ?`)
        .all(folderBRow.id)
    ).toEqual([{ filename: "2.jpg" }]);
  });

  it("returns false for an unknown folder id", () => {
    const db = getDb();
    expect(deleteFolder(db, 999999)).toBe(false);
  });
});

describe("deleteFolderSubtree", () => {
  const one = (name) => [{ name, size: 10, mtimeMs: 1, kind: "image" }];

  it("removes a parent AND its descendant folders — not just the parent's own row", () => {
    const db = getDb();
    // A parent that has its own photos AND children (the real-library shape that
    // made Remove look like a no-op: dropping only the parent left the children,
    // which reconstruct the parent).
    upsertScan(db, "/lib/Cam 1", 1, one("p.jpg"));
    upsertScan(db, "/lib/Cam 1/Cam 2", 1, one("c2.jpg"));
    upsertScan(db, "/lib/Cam 1/Cam 3", 1, one("c3.jpg"));
    // A sibling of the parent that must survive.
    upsertScan(db, "/lib/Other", 1, one("o.jpg"));

    const res = deleteFolderSubtree(db, "/lib/Cam 1");
    expect(res).toEqual({ folders: 3, photos: 3 });

    const remaining = db
      .prepare(`SELECT abs_path FROM folders ORDER BY abs_path`)
      .all()
      .map((r) => r.abs_path);
    expect(remaining).toEqual(["/lib/Other"]);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM photos`).get().c).toBe(1);
  });

  it("removes a pure ancestor that has no row of its own (only sub-folders)", () => {
    const db = getDb();
    // Nothing was scanned at "/lib/parent" itself — only below it.
    upsertScan(db, "/lib/parent/a", 1, one("a.jpg"));
    upsertScan(db, "/lib/parent/b", 1, one("b.jpg"));

    const res = deleteFolderSubtree(db, "/lib/parent");
    expect(res).toEqual({ folders: 2, photos: 2 });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM folders`).get().c).toBe(0);
  });

  it("does not sweep a sibling whose name only differs where a '_' sits (LIKE escaping)", () => {
    const db = getDb();
    // '_' is a LIKE wildcard. Without ESCAPE, the prefix for "2025_a" would also
    // match "2025Xa" — a different real folder. The trailing-slash prefix plus
    // escaping must keep them apart.
    upsertScan(db, "/lib/2025_a", 1, one("keep.jpg"));
    upsertScan(db, "/lib/2025_a/child", 1, one("gone.jpg"));
    upsertScan(db, "/lib/2025Xa", 1, one("survivor.jpg"));

    const res = deleteFolderSubtree(db, "/lib/2025_a");
    expect(res).toEqual({ folders: 2, photos: 2 });
    const remaining = db
      .prepare(`SELECT abs_path FROM folders ORDER BY abs_path`)
      .all()
      .map((r) => r.abs_path);
    expect(remaining).toEqual(["/lib/2025Xa"]);
  });

  it("removes nothing (folders:0) for a path that matches no folder or descendant", () => {
    const db = getDb();
    upsertScan(db, "/lib/a", 1, one("a.jpg"));
    expect(deleteFolderSubtree(db, "/lib/nope")).toEqual({
      folders: 0,
      photos: 0,
    });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM folders`).get().c).toBe(1);
  });
});

describe("upsertScan — btime (creation date)", () => {
  it("stores btime from the scanned file record", () => {
    const db = getDb();
    upsertScan(db, "/photos/a", 1, [
      { name: "x.jpg", size: 10, mtimeMs: 200, btimeMs: 100, kind: "image" },
    ]);
    const row = db
      .prepare(`SELECT btime FROM photos WHERE filename = 'x.jpg'`)
      .get();
    expect(row.btime).toBe(100);
  });

  it("backfills btime for a previously-scanned file on rescan", () => {
    const db = getDb();
    // First scan without btime (simulates a row created before this column).
    upsertScan(db, "/photos/a", 1, [
      { name: "x.jpg", size: 10, mtimeMs: 200, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET btime = NULL WHERE filename = 'x.jpg'`).run();
    // Rescan now carries btime → the unconditional upsert backfills it.
    upsertScan(db, "/photos/a", 1, [
      { name: "x.jpg", size: 10, mtimeMs: 200, btimeMs: 150, kind: "image" },
    ]);
    const row = db
      .prepare(`SELECT btime FROM photos WHERE filename = 'x.jpg'`)
      .get();
    expect(row.btime).toBe(150);
  });
});

describe("repointPhoto", () => {
  it("moves the photo to a new folder row and updates its filename, leaving the old folder row untouched", () => {
    const db = getDb();
    const [row] = upsertScan(db, "/photos/trip", 1, [FILES[0]]);

    repointPhoto(db, row.id, "/photos/album-2026-01-01/a-renamed.jpg");

    const photo = getPhotoById(db, row.id);
    expect(photo.path).toBe(join("/photos/album-2026-01-01", "a-renamed.jpg"));
    expect(photo.filename).toBe("a-renamed.jpg");

    const newFolder = db
      .prepare(`SELECT * FROM folders WHERE abs_path = ?`)
      .get("/photos/album-2026-01-01");
    expect(newFolder).toBeDefined();

    const oldFolder = db
      .prepare(`SELECT * FROM folders WHERE abs_path = ?`)
      .get("/photos/trip");
    expect(oldFolder).toBeDefined(); // source folder row is untouched
  });

  it("reuses an existing folder row for the destination dir instead of duplicating it", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    upsertScan(db, "/photos/album", 1, [FILES[1]]); // pre-existing dest folder

    repointPhoto(db, a.id, "/photos/album/a.jpg");

    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM folders WHERE abs_path = ?`)
      .get("/photos/album").c;
    expect(count).toBe(1);
  });
});

describe("resetLibrary", () => {
  it("clears every table and returns pre-delete counts", () => {
    const db = getDb();
    upsertScan(db, "/a", 1, [
      { name: "1.jpg", size: 10, mtimeMs: 1, kind: "image" },
      { name: "2.jpg", size: 20, mtimeMs: 2, kind: "image" },
    ]);
    upsertScan(db, "/b", 1, [
      { name: "3.jpg", size: 30, mtimeMs: 3, kind: "image" },
    ]);
    db.prepare(`INSERT INTO albums (id, name) VALUES (1, 'Trip')`).run();
    db.prepare(
      `INSERT INTO photo_album (photo_id, album_id) VALUES (1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO tags (id, dimension_name, value) VALUES (1, 'kind', 'sunset')`
    ).run();
    db.prepare(
      `INSERT INTO photo_tags (photo_id, tag_id, source) VALUES (1, 1, 'manual')`
    ).run();

    const result = resetLibrary(db);
    expect(result).toEqual({ folders: 2, photos: 3 });

    for (const table of [
      "volumes",
      "folders",
      "photos",
      "albums",
      "photo_album",
      "tags",
      "photo_tags",
    ]) {
      const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
      expect(count).toBe(0);
    }
  });

  it("never touches files on disk", async () => {
    const db = getDb();
    upsertScan(db, cacheDir, 1, [
      { name: "untouched.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { writeFile: wf } = await import("node:fs/promises");
    const filePath = join(cacheDir, "untouched.jpg");
    await wf(filePath, "not a real image");

    resetLibrary(db);

    const { existsSync } = await import("node:fs");
    expect(existsSync(filePath)).toBe(true);
  });
});
