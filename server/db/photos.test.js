import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectNoBlockOver } from "../lib/expectNoBlockOver.js";
import { getDb, _resetDbForTest } from "./connection.js";
import {
  upsertScan,
  getPhotoById,
  setPhotoRating,
  setPhotoCover,
  deleteFolder,
  deleteFolderSubtree,
  deletePhotosByIds,
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

  it("preserves gps_checked when a file is unchanged, clears it when changed", () => {
    // Mirrors the content_hash case above: a changed file may have been
    // re-exported with different (or stripped) GPS, so a rescan must clear the
    // "we looked" marker and let the sweep look again (see enrich.js
    // PENDING_CONDITION / gps_checked docs).
    const db = getDb();
    const [first] = upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    db.prepare("UPDATE photos SET gps_checked = 1 WHERE id = ?").run(first.id);

    // Rescan unchanged: gps_checked survives.
    upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    expect(getPhotoById(db, first.id).gps_checked).toBe(1);

    // Rescan with a changed size: gps_checked is cleared.
    upsertScan(db, "/photos/trip", 1, [{ ...FILES[0], size: 999 }]);
    expect(getPhotoById(db, first.id).gps_checked).toBe(0);
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

  it("treats a trailing-slash path as the same folder (no duplicate rows/photos)", () => {
    // A path that arrives with a trailing separator (folder picker, pasted
    // path, recursive root) must not become a SECOND folders row for the same
    // physical directory — that row holds the same files and the feed then
    // renders every photo twice (#138).
    const db = getDb();
    upsertScan(db, "/photos/trip", 1, FILES);
    upsertScan(db, "/photos/trip/", 1, FILES);
    const folders = db.prepare("SELECT COUNT(*) AS c FROM folders").get().c;
    expect(folders).toBe(1);
    const photos = db
      .prepare("SELECT COUNT(*) AS c FROM photos WHERE stale = 0")
      .get().c;
    expect(photos).toBe(FILES.length);
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

describe("deletePhotosByIds", () => {
  it("removes only the named photos and their tag/album links", () => {
    const db = getDb();
    const [p1, p2, p3] = upsertScan(db, "/photos/mix", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "2.jpg", size: 2, mtimeMs: 2, kind: "image" },
      { name: "3.jpg", size: 3, mtimeMs: 3, kind: "image" },
    ]);
    db.prepare(`INSERT INTO albums (id, name) VALUES (1, 'Trip')`).run();
    db.prepare(
      `INSERT INTO photo_album (photo_id, album_id) VALUES (?, 1)`
    ).run(p1.id);
    db.prepare(
      `INSERT INTO tags (id, dimension_name, value) VALUES (1, 'kind', 'x')`
    ).run();
    db.prepare(
      `INSERT INTO photo_tags (photo_id, tag_id, source) VALUES (?, 1, 'manual')`
    ).run(p1.id);

    const res = deletePhotosByIds(db, [p1.id, p2.id]);
    expect(res.photos).toBe(2);

    // p3 survives; p1/p2 and p1's junction rows are gone.
    expect(getPhotoById(db, p3.id)).toBeTruthy();
    expect(getPhotoById(db, p1.id)).toBeFalsy();
    expect(getPhotoById(db, p2.id)).toBeFalsy();
    expect(db.prepare(`SELECT COUNT(*) AS c FROM photo_album`).get().c).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM photo_tags`).get().c).toBe(0);
    // The folder still has p3, so it is NOT pruned.
    expect(res.folders).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM folders`).get().c).toBe(1);
  });

  it("prunes a folder emptied by the removal, but not one still holding photos", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/photos/solo", 1, [
      { name: "only.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const [b] = upsertScan(db, "/photos/keep", 1, [
      { name: "stay.jpg", size: 2, mtimeMs: 2, kind: "image" },
      { name: "also.jpg", size: 3, mtimeMs: 3, kind: "image" },
    ]);
    // Remove the only photo in /solo and ONE of two in /keep.
    const res = deletePhotosByIds(db, [a.id, b.id]);
    expect(res.photos).toBe(2);
    expect(res.folders).toBe(1); // /solo pruned, /keep kept
    const paths = db
      .prepare(`SELECT abs_path FROM folders ORDER BY abs_path`)
      .all()
      .map((r) => r.abs_path);
    expect(paths).toEqual(["/photos/keep"]);
  });

  it("is a no-op for an empty or garbage id list", () => {
    const db = getDb();
    upsertScan(db, "/photos/x", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    expect(deletePhotosByIds(db, [])).toEqual({ photos: 0, folders: 0 });
    expect(deletePhotosByIds(db, null)).toEqual({ photos: 0, folders: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM photos`).get().c).toBe(1);
  });
});

describe("resetLibrary", () => {
  it("clears every table and returns pre-delete counts", async () => {
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

    const result = await resetLibrary(db);
    // `canceled` joins the shape now that this is interruptible (#281).
    expect(result).toEqual({ folders: 2, photos: 3, canceled: false });

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

    await resetLibrary(db);

    const { existsSync } = await import("node:fs");
    expect(existsSync(filePath)).toBe(true);
  });
});

describe("resetLibrary is interruptible and chunked (#281)", () => {
  /** `n` photos in one folder. */
  function seedMany(db, n) {
    return upsertScan(
      db,
      "/vol/many",
      1,
      Array.from({ length: n }, (_, i) => ({
        name: `m${i}.jpg`,
        size: 10,
        mtimeMs: 1000 + i,
        kind: "image",
      }))
    ).length;
  }

  it("deletes in chunks, yielding between them", async () => {
    // The property that lets the server answer while a reset runs. One
    // transaction over 125,000 photos measured at 1.3 s with nothing able to
    // interrupt it; chunked, each hold is milliseconds.
    const db = getDb();
    seedMany(db, 25);
    const seen = [];
    const r = await resetLibrary(db, {
      chunk: 5,
      onProgress: (p) => seen.push(p.done),
    });
    expect(r.photos).toBe(25);
    // Five chunks of five, reported as it went — not one silent block.
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(seen.at(-1)).toBe(25);
    expect(db.prepare(`SELECT COUNT(*) c FROM photos`).get().c).toBe(0);
  });

  it("never holds the loop for a frame, at the SHIPPED chunk size", async () => {
    // The lesson of `docs/ARCHITECTURE-REVIEW-2026-08-04.md` §9, and the
    // reason the two tests above are not enough: they inject `chunk: 5`, so
    // they assert that the loop honours AN INJECTED budget and would pass
    // identically if the shipped default were a million. That is precisely the
    // shape of the #231 test that failed to catch #231.
    //
    // This one passes no options at all and measures MILLISECONDS, which is
    // what the user experiences. 20,000 photos is enough that a single
    // transaction would be plainly visible; the budget has CI headroom.
    const db = getDb();
    seedMany(db, 20_000);
    const worst = await expectNoBlockOver(120, () => resetLibrary(db), {
      label: "resetLibrary at 20k photos",
    });
    expect(worst).toBeLessThan(120);
    expect(db.prepare(`SELECT COUNT(*) c FROM photos`).get().c).toBe(0);
  }, 60_000);

  it("stops when cancelled, and what it deleted stays deleted", async () => {
    // A partial reset is a coherent state: the rows that went are gone and the
    // rest are still indexed. It must say so rather than implying a full wipe.
    const db = getDb();
    seedMany(db, 30);
    const controller = new AbortController();
    const r = await resetLibrary(db, {
      chunk: 5,
      signal: controller.signal,
      onProgress: ({ done }) => {
        if (done >= 10) controller.abort();
      },
    });
    expect(r.canceled).toBe(true);
    const left = db.prepare(`SELECT COUNT(*) c FROM photos`).get().c;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(30);
  });
});
