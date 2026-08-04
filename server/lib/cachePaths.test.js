import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  thumbCachePath,
  tmpCachePath,
  thumbCacheKey,
  THUMB_BUCKETS,
  thumbsDir,
  cacheRoot,
} from "./cachePaths.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-paths-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("thumbCachePath", () => {
  const photo = {
    path: "/vol/Trip/IMG_1.jpg",
    mtime: 1700000000000,
    size: 4242,
  };

  it("is the sha1 of path:mtime:size:bucket, under thumbsDir, with .jpg", () => {
    const expected = createHash("sha1")
      .update(`${photo.path}:${photo.mtime}:${photo.size}:320`)
      .digest("hex");
    expect(thumbCachePath(photo, 320)).toBe(
      join(thumbsDir(), `${expected}.jpg`)
    );
  });

  it("gives a different path per bucket", () => {
    const paths = THUMB_BUCKETS.map((b) => thumbCachePath(photo, b));
    expect(new Set(paths).size).toBe(THUMB_BUCKETS.length);
  });

  it("changes when the source file's mtime or size changes", () => {
    const base = thumbCachePath(photo, 320);
    expect(thumbCachePath({ ...photo, mtime: 1 }, 320)).not.toBe(base);
    expect(thumbCachePath({ ...photo, size: 1 }, 320)).not.toBe(base);
  });

  it("exports every bucket the client can request", () => {
    expect(THUMB_BUCKETS).toEqual([160, 320, 480, 640, 1024]);
  });

  it("is the join of thumbsDir(), the key, and .jpg (the invariant)", () => {
    expect(thumbCachePath(photo, 320)).toBe(
      join(thumbsDir(), `${thumbCacheKey(photo, 320)}.jpg`)
    );
  });
});

describe("thumbCacheKey", () => {
  const photo = {
    path: "/vol/Trip/IMG_1.jpg",
    mtime: 1700000000000,
    size: 4242,
  };

  it("returns a bare 40-char hex SHA1 string", () => {
    const key = thumbCacheKey(photo, 320);
    expect(key).toMatch(/^[a-f0-9]{40}$/);
  });

  it("contains no path separators or file extensions", () => {
    const key = thumbCacheKey(photo, 320);
    expect(key).not.toContain("/");
    expect(key).not.toContain("\\");
    expect(key).not.toContain(".");
  });

  it("is identical to the filename extracted from thumbCachePath", () => {
    const path = thumbCachePath(photo, 320);
    const filename = basename(path, ".jpg");
    expect(thumbCacheKey(photo, 320)).toBe(filename);
  });
});

describe("tmpCachePath", () => {
  const photo = { path: "/vol/Trip/IMG_1.jpg", mtime: 1700000000000, size: 42 };

  it("never hands two writers the same temp path for the same cache entry", () => {
    // The hazard #161 introduced: GET /api/thumb/:id and the embedding sweep
    // (server/ml/thumbSource.js) both write the 320px bucket, in the same
    // process, unserialized. Two concurrent writeFile()s to one temp path
    // followed by a rename put a TORN JPEG in the cache under a valid key —
    // and the key only changes when the photo's bytes do, so the grid serves
    // the corrupt image forever after.
    const cachePath = thumbCachePath(photo, 320);
    const a = tmpCachePath(cachePath);
    const b = tmpCachePath(cachePath);
    expect(a).not.toBe(b);
  });

  it("stays under thumbsDir and outside the .jpg key space pruneOrphanedCache keeps", () => {
    // pruneOrphanedCache sweeps anything here that is not an expected .jpg
    // key, which is what collects a temp file orphaned by a crash — but it
    // must never collect a LIVE thumbnail, so the temp name has to be
    // distinguishable.
    const cachePath = thumbCachePath(photo, 320);
    const tmp = tmpCachePath(cachePath);
    expect(tmp.startsWith(cachePath)).toBe(true);
    expect(tmp.endsWith(".tmp")).toBe(true);
    expect(basename(tmp).endsWith(".jpg")).toBe(false);
  });
});

describe("the real library is unreachable from a test run", () => {
  /**
   * Asked by John, and the honest answer at the time was "yes, but only by
   * convention". Every destructive test set AUTOGALLERY_HOME in a
   * `beforeEach`; nothing enforced it, and `cacheRoot()` fell back to the real
   * `~/.autogallery` when it was missing. A new test file that forgot the
   * hook — or any `getDb()` at module scope, which runs BEFORE any hook —
   * would have pointed `resetLibrary` at his actual index.
   */
  it("refuses to resolve ~/.autogallery when the override is missing", async () => {
    const saved = process.env.AUTOGALLERY_HOME;
    delete process.env.AUTOGALLERY_HOME;
    try {
      expect(() => cacheRoot()).toThrow(/AUTOGALLERY_HOME is not set/);
    } finally {
      process.env.AUTOGALLERY_HOME = saved;
    }
  });

  it("still honours an explicit override", () => {
    const saved = process.env.AUTOGALLERY_HOME;
    process.env.AUTOGALLERY_HOME = "/tmp/ag-somewhere";
    try {
      expect(cacheRoot()).toBe("/tmp/ag-somewhere");
    } finally {
      process.env.AUTOGALLERY_HOME = saved;
    }
  });
});
