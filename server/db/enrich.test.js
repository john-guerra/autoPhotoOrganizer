import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import {
  pendingMetaPhotos,
  pendingMetaCount,
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
