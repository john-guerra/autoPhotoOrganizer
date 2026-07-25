import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  thumbCachePath,
  thumbCacheKey,
  THUMB_BUCKETS,
  thumbsDir,
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
