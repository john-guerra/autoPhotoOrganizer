import { expectNoBlockOver } from "./expectNoBlockOver.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getDb, _resetDbForTest } from "../db/connection.js";
import { upsertScan } from "../db/photos.js";
import {
  getCacheStats,
  getCacheBreakdown,
  clearCache,
  pruneOrphanedCache,
} from "./cacheStats.js";

let cacheDir;

function cacheKeyFor(path, mtime, size, bucket) {
  return createHash("sha1")
    .update(`${path}:${mtime}:${size}:${bucket}`)
    .digest("hex");
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-cachestats-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("getCacheStats", () => {
  it("sums bytes and counts files in the thumbnail cache dir", async () => {
    const dir = join(cacheDir, "cache", "thumbs");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.jpg"), Buffer.alloc(100));
    await writeFile(join(dir, "b.jpg"), Buffer.alloc(50));

    const stats = getCacheStats();
    expect(stats).toEqual({ totalBytes: 150, totalFiles: 2 });
  });

  it("returns zeros for an empty cache", async () => {
    expect(getCacheStats()).toEqual({ totalBytes: 0, totalFiles: 0 });
  });
});

describe("getCacheBreakdown", () => {
  it("attributes a cached thumbnail's bytes to its source folder", async () => {
    const db = getDb();
    db.prepare(`INSERT INTO volumes (id, label) VALUES (?, ?)`).run(
      1,
      "test-volume"
    );
    upsertScan(db, "/photos/folderA", 1, [
      { name: "a.jpg", size: 111, mtimeMs: 222, kind: "image" },
    ]);
    const folder = db
      .prepare(`SELECT id FROM folders WHERE abs_path = '/photos/folderA'`)
      .get();

    const dir = join(cacheDir, "cache", "thumbs");
    await mkdir(dir, { recursive: true });
    const key = cacheKeyFor(
      join("/photos/folderA", "a.jpg"),
      222,
      111,
      320 // one of THUMB_BUCKETS
    );
    await writeFile(join(dir, `${key}.jpg`), Buffer.alloc(77));

    const breakdown = await getCacheBreakdown(db);
    expect(breakdown.folders).toEqual([
      {
        id: folder.id,
        path: "/photos/folderA",
        cachedBytes: 77,
        cachedFiles: 1,
      },
    ]);
  });

  it("returns an empty list when nothing is indexed", async () => {
    const db = getDb();
    expect(await getCacheBreakdown(db)).toEqual({ folders: [] });
  });
});

describe("clearCache", () => {
  it("deletes every file in the cache dir and reports what was freed", async () => {
    const dir = join(cacheDir, "cache", "thumbs");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.jpg"), Buffer.alloc(10));
    await writeFile(join(dir, "b.jpg"), Buffer.alloc(20));

    const result = await clearCache();
    // `canceled` joins the shape now that this is interruptible (#281).
    expect(result).toEqual({ freedBytes: 30, freedFiles: 2, canceled: false });
    expect(getCacheStats()).toEqual({ totalBytes: 0, totalFiles: 0 });
  });
});

describe("pruneOrphanedCache", () => {
  it("removes only files with no corresponding indexed photo", async () => {
    const db = getDb();
    db.prepare(`INSERT INTO volumes (id, label) VALUES (?, ?)`).run(
      1,
      "test-volume"
    );
    upsertScan(db, "/photos/folderB", 1, [
      { name: "live.jpg", size: 5, mtimeMs: 9, kind: "image" },
    ]);

    const dir = join(cacheDir, "cache", "thumbs");
    await mkdir(dir, { recursive: true });
    const liveKey = cacheKeyFor(join("/photos/folderB", "live.jpg"), 9, 5, 160);
    await writeFile(join(dir, `${liveKey}.jpg`), Buffer.alloc(10));
    await writeFile(join(dir, "orphan123.jpg"), Buffer.alloc(20));

    const result = pruneOrphanedCache(db);
    expect(result).toEqual({ freedBytes: 20, freedFiles: 1 });

    const remaining = getCacheStats();
    expect(remaining).toEqual({ totalBytes: 10, totalFiles: 1 });
  });
});

describe("clearCache does not wedge the server (#281)", () => {
  it("never holds the loop for a frame, at the SHIPPED batch size", async () => {
    // The measurement this guards: 8.42 s of unyielded syscalls for 125,000
    // files, during which /api/health did not answer and the client declared
    // the server dead. `docs/ARCHITECTURE-REVIEW-2026-08-04.md` §2.
    //
    // No options are passed, deliberately — a test that injects its own batch
    // size proves the loop honours the injected budget and nothing about the
    // shipped one (the #231 mistake, review §9). 8,000 files is enough for the
    // old shape to be plainly visible; the budget has CI headroom.
    const dir = join(cacheDir, "cache", "thumbs");
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: 8000 }, (_, i) =>
        writeFile(join(dir, `t${i}.jpg`), Buffer.alloc(8))
      )
    );
    // BUDGET: 400ms, and the number is measured, not hoped for. Under the
    // full suite (8 parallel vitest workers on 8 cores) the correct
    // implementation measures ~143ms worst — that is OS descheduling, not this
    // function, whose 8,000 syscalls total ~40ms. In isolation it is under
    // 20ms. 400 clears the noise floor with room and still fails hard on a
    // regression: with the yield removed the probe does not fire AT ALL, which
    // `expectNoBlockOver` reports as total starvation whatever the budget says.
    const worst = await expectNoBlockOver(400, () => clearCache(), {
      label: "clearCache at 8k thumbnails",
    });
    expect(worst).toBeLessThan(400);
    expect(getCacheStats().totalFiles).toBe(0);
  }, 60_000);

  it("stops when cancelled, and says how much it got through", async () => {
    // Half a cache is a perfectly good cache, so stopping is always safe —
    // but the summary must not imply a full clear.
    const dir = join(cacheDir, "cache", "thumbs");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 1200; i++) {
      await writeFile(join(dir, `c${i}.jpg`), Buffer.alloc(4));
    }
    const controller = new AbortController();
    const r = await clearCache({
      batch: 100,
      signal: controller.signal,
      onProgress: ({ done }) => {
        if (done >= 300) controller.abort();
      },
    });
    expect(r.canceled).toBe(true);
    expect(r.freedFiles).toBeGreaterThan(0);
    expect(getCacheStats().totalFiles).toBeGreaterThan(0);
  });
});
