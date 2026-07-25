import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getDb, _resetDbForTest } from "./connection.js";
import { applySchema } from "./schema.js";
import { upsertScan } from "./photos.js";
import {
  pendingMetaPhotos,
  pendingMetaCount,
  photosByIds,
  writeMeta,
  enrichBatch,
} from "./enrich.js";

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

function seed(db, names) {
  db.prepare(`INSERT INTO volumes (id, label) VALUES (1, 'vol1')`).run();
  return upsertScan(
    db,
    "/photos/trip",
    1,
    names.map((name) => ({ name, size: 1, mtimeMs: 1, kind: "image" }))
  );
}

/** A ProcessingService stub: returns one meta per path, and can be told to throw. */
function fakeProcessing(metaFor, { throwOnBatch = null } = {}) {
  return {
    calls: [],
    async metadata(paths) {
      this.calls.push(paths);
      if (throwOnBatch && paths.length > 1 && paths.some(throwOnBatch)) {
        throw new Error("exiftool blew up on the batch");
      }
      if (throwOnBatch && paths.length === 1 && throwOnBatch(paths[0])) {
        throw new Error("unreadable file");
      }
      return paths.map((path) => metaFor(path));
    },
  };
}

describe("pendingMetaPhotos / pendingMetaCount", () => {
  it("lists exactly the photos nobody has read yet", () => {
    const db = getDb();
    const [a, b] = seed(db, ["a.jpg", "b.jpg"]);
    expect(pendingMetaCount(db)).toBe(2);

    writeMeta(db, a.id, { width: 100, height: 50 });
    expect(pendingMetaCount(db)).toBe(1);
    expect(pendingMetaPhotos(db).map((p) => p.id)).toEqual([b.id]);
  });

  it("counts a RAW that was read but yielded no dimensions as DONE, not pending", () => {
    // width 0 = "we looked, there was nothing" (sharp can't read most RAW
    // headers). If this counted as pending, the sweep would re-read it forever.
    const db = getDb();
    const [a] = seed(db, ["a.cr2"]);
    writeMeta(db, a.id, {}); // no width in the meta at all
    expect(pendingMetaCount(db)).toBe(0);
    expect(pendingMetaPhotos(db)).toEqual([]);
  });

  it("excludes stale photos", () => {
    const db = getDb();
    const [a] = seed(db, ["a.jpg"]);
    db.prepare(`UPDATE photos SET stale = 1 WHERE id = ?`).run(a.id);
    expect(pendingMetaCount(db)).toBe(0);
  });
});

describe("photosByIds", () => {
  it("handles a whole-library id list without blowing SQLite's parameter limit", () => {
    // ⌘A on a big library, then "Re-read metadata". One `IN (?,?,…)` per id
    // exceeds SQLITE_MAX_VARIABLE_NUMBER (32766) and throws "too many SQL
    // variables" — and since the route is an async handler, Express 4 doesn't
    // catch it: the throw KILLED THE SERVER. 40k is over the ceiling; 500 would
    // sail past this test, which is why the number here is deliberately large.
    const db = getDb();
    const names = Array.from({ length: 40000 }, (_, i) => `p${i}.jpg`);
    const rows = seed(db, names);
    expect(rows).toHaveLength(40000);

    const found = photosByIds(
      db,
      rows.map((r) => r.id)
    );
    expect(found).toHaveLength(40000);
  });

  it("re-reads photos it has already read (unlike the sweep, it ignores the sentinel)", () => {
    const db = getDb();
    const [a] = seed(db, ["a.jpg"]);
    writeMeta(db, a.id, { width: 100, height: 50 }); // already read
    expect(pendingMetaPhotos(db)).toEqual([]); // the sweep would skip it…
    expect(photosByIds(db, [a.id])).toHaveLength(1); // …a forced re-read won't
  });

  it("skips stale photos — they aren't on disk to read", () => {
    const db = getDb();
    const [a] = seed(db, ["a.jpg"]);
    db.prepare(`UPDATE photos SET stale = 1 WHERE id = ?`).run(a.id);
    expect(photosByIds(db, [a.id])).toEqual([]);
  });
});

describe("writeMeta", () => {
  it("stores the EXIF date, and the sentinels the date fallback depends on", () => {
    const db = getDb();
    const [a] = seed(db, ["a.jpg"]);
    writeMeta(db, a.id, {
      createDate: new Date("2017-06-15T00:00:00.000Z"),
      width: 4000,
      height: 3000,
      camera: "Canon R6",
    });
    const row = db.prepare(`SELECT * FROM photos WHERE id = ?`).get(a.id);
    expect(row.taken_at).toBe(Date.parse("2017-06-15T00:00:00.000Z"));
    expect(row.width).toBe(4000);
    expect(row.lens).toBe(""); // "" = EXIF attempted, none found
  });

  it("marks a photo with NO metadata as attempted (width 0), not untried (NULL)", () => {
    const db = getDb();
    const [a] = seed(db, ["a.jpg"]);
    writeMeta(db, a.id, {});
    const row = db.prepare(`SELECT * FROM photos WHERE id = ?`).get(a.id);
    expect(row.width).toBe(0); // NOT null — null would mean "try again forever"
    expect(row.taken_at).toBe(null);
  });
});

describe("enrichBatch", () => {
  it("reads a batch and writes every row", async () => {
    const db = getDb();
    const rows = seed(db, ["a.jpg", "b.jpg"]);
    const processing = fakeProcessing(() => ({
      createDate: new Date("2020-01-01T00:00:00.000Z"),
      width: 10,
      height: 10,
    }));

    const n = await enrichBatch(db, processing, pendingMetaPhotos(db));
    expect(n).toBe(2);
    expect(pendingMetaCount(db)).toBe(0);
    expect(
      db.prepare(`SELECT taken_at FROM photos WHERE id = ?`).get(rows[0].id)
        .taken_at
    ).toBe(Date.parse("2020-01-01T00:00:00.000Z"));
  });

  it("is resumable: the to-do list IS 'width IS NULL', so a cancelled sweep just resumes", async () => {
    // The property that makes cancel/crash safe — no cursor, no bookkeeping.
    const db = getDb();
    seed(db, ["a.jpg", "b.jpg", "c.jpg"]);
    const processing = fakeProcessing(() => ({ width: 1, height: 1 }));

    // "Cancel" after one batch of 2.
    await enrichBatch(db, processing, pendingMetaPhotos(db, { limit: 2 }));
    expect(pendingMetaCount(db)).toBe(1);

    // Resuming re-reads nothing already done, and finishes the rest.
    await enrichBatch(db, processing, pendingMetaPhotos(db));
    expect(pendingMetaCount(db)).toBe(0);
    expect(processing.calls.flat()).toHaveLength(3); // each file read ONCE
  });

  it("does no partial write when extraction throws", async () => {
    const db = getDb();
    seed(db, ["a.jpg", "b.jpg"]);
    const processing = fakeProcessing(() => ({ width: 1, height: 1 }), {
      throwOnBatch: (p) => p.endsWith("b.jpg"),
    });
    await expect(
      enrichBatch(db, processing, pendingMetaPhotos(db))
    ).rejects.toThrow();
    // Still pending: the caller retries these one-by-one to isolate the bad file.
    expect(pendingMetaCount(db)).toBe(2);
  });
});

describe("the video-codec backfill", () => {
  /** Seed one video, the way a scan does. */
  function seedVideo(db, name = "clip.mp4") {
    db.prepare(`INSERT INTO volumes (id, label) VALUES (1, 'vol1')`).run();
    return upsertScan(db, "/photos/trip", 1, [
      { name, size: 1, mtimeMs: 1, kind: "video" },
    ])[0];
  }

  it("re-reads a video that was enriched BEFORE video_codec existed", () => {
    // The bug: video_codec and pix_fmt were added to the schema long after the
    // videos were indexed. Those rows already had a width, and the sweep only
    // asked for `width IS NULL` — so they could never come back through it. On
    // the real library that stranded 1,171 of 1,173 videos with no codec, which
    // means playback had to ffprobe each one on demand, with the loupe open and
    // the user waiting.
    const db = getDb();
    const v = seedVideo(db);
    db.prepare(
      `UPDATE photos SET width = 1920, height = 1080, video_codec = NULL WHERE id = ?`
    ).run(v.id);

    expect(pendingMetaCount(db)).toBe(1);
    expect(pendingMetaPhotos(db).map((p) => p.id)).toEqual([v.id]);
  });

  it("stops asking once the video HAS been probed", () => {
    const db = getDb();
    const v = seedVideo(db);
    writeMeta(db, v.id, { width: 1920, height: 1080, videoCodec: "hevc" });
    expect(pendingMetaCount(db)).toBe(0);
  });

  it("stops asking for a video ffprobe could not read, too", () => {
    // "" is the sentinel for "we looked, there was no video stream" — the same
    // shape as width 0 for a RAW. Without it, an unreadable clip would come back
    // pending on every sweep, forever, and the sweep would never finish.
    const db = getDb();
    const v = seedVideo(db);
    writeMeta(db, v.id, { width: 0, height: 0 }); // ffprobe found nothing
    expect(
      db.prepare(`SELECT video_codec FROM photos WHERE id = ?`).get(v.id)
    ).toEqual({ video_codec: "" });
    expect(pendingMetaCount(db)).toBe(0);
  });

  it("does not drag every already-read PHOTO back into the sweep", () => {
    // The pending condition must key on kind — an image has no video_codec and
    // never will, and re-reading 113k of them would be a catastrophe.
    const db = getDb();
    const [a] = seed(db, ["a.jpg"]);
    writeMeta(db, a.id, { width: 100, height: 50 });
    expect(pendingMetaCount(db)).toBe(0);
  });
});

describe("GPS + place persistence", () => {
  let db, photoId;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    db.prepare("INSERT INTO folders (abs_path) VALUES ('/lib')").run();
    photoId = db
      .prepare(
        `INSERT INTO photos (folder_id, filename, size, mtime, kind)
         VALUES (1, 'a.jpg', 10, 100, 'image')`
      )
      .run().lastInsertRowid;
  });

  it("stores coordinates and the resolved place", () => {
    writeMeta(db, photoId, { width: 4, height: 3, lat: 4.711, lon: -74.0721 });
    const row = db
      .prepare(
        "SELECT lat, lon, place_country, place_city, gps_checked FROM photos"
      )
      .get();
    expect(row.lat).toBeCloseTo(4.711, 4);
    expect(row.place_country).toBe("Colombia");
    expect(row.gps_checked).toBe(1);
  });

  it("marks gps_checked even when the photo has NO GPS, so it is not retried forever", () => {
    writeMeta(db, photoId, { width: 4, height: 3 });
    const row = db
      .prepare("SELECT lat, place_country, gps_checked FROM photos")
      .get();
    expect(row.lat).toBeNull();
    expect(row.place_country).toBe(""); // the Unknown sentinel, not null
    expect(row.gps_checked).toBe(1);
  });

  it("an already-enriched photo with gps_checked = 0 is still pending (backfill)", () => {
    // Simulates a row enriched BEFORE this feature existed: it has a width, so
    // the old PENDING_CONDITION considered it done.
    db.prepare(
      "UPDATE photos SET width = 100, height = 50, gps_checked = 0"
    ).run();
    expect(pendingMetaCount(db)).toBe(1);
  });

  it("stops being pending once it has been checked", () => {
    db.prepare(
      "UPDATE photos SET width = 100, height = 50, gps_checked = 1"
    ).run();
    expect(pendingMetaCount(db)).toBe(0);
  });
});
