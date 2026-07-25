import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thumbCachePath } from "../lib/cachePaths.js";
import { thumbBytes, EMBED_THUMB_SIZE } from "./thumbSource.js";

let cacheDir;
const photo = {
  path: "/vol/Trip/IMG_1.jpg",
  mtime: 1700000000000,
  size: 4242,
  kind: "image",
};
const video = {
  path: "/vol/Trip/CLIP.MOV",
  mtime: 1700000000001,
  size: 999,
  kind: "video",
};

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-thumbsrc-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("thumbBytes", () => {
  it("reads the cached 320px thumb without touching the processor", async () => {
    await writeFile(
      thumbCachePath(photo, EMBED_THUMB_SIZE),
      Buffer.from("cached")
    );
    const processing = { thumbnail: vi.fn(), videoThumb: vi.fn() };

    expect(await thumbBytes(photo, processing)).toEqual(Buffer.from("cached"));
    expect(processing.thumbnail).not.toHaveBeenCalled();
  });

  it("generates AND caches on a miss, so the grid is warm afterwards", async () => {
    const processing = {
      thumbnail: vi.fn().mockResolvedValue({ data: Buffer.from("fresh") }),
      videoThumb: vi.fn(),
    };

    expect(await thumbBytes(photo, processing)).toEqual(Buffer.from("fresh"));
    expect(processing.thumbnail).toHaveBeenCalledWith(photo.path, 320);

    // Second call is served from the cache the first one wrote.
    expect(await thumbBytes(photo, processing)).toEqual(Buffer.from("fresh"));
    expect(processing.thumbnail).toHaveBeenCalledTimes(1);
  });

  it("uses videoThumb for a video's poster frame", async () => {
    const processing = {
      thumbnail: vi.fn(),
      videoThumb: vi.fn().mockResolvedValue({ data: Buffer.from("poster") }),
    };

    expect(await thumbBytes(video, processing)).toEqual(Buffer.from("poster"));
    expect(processing.videoThumb).toHaveBeenCalledWith(video.path, 320);
    expect(processing.thumbnail).not.toHaveBeenCalled();
  });

  it("leaves no .tmp file behind after a successful write", async () => {
    const processing = {
      thumbnail: vi.fn().mockResolvedValue({ data: Buffer.from("fresh") }),
      videoThumb: vi.fn(),
    };
    await thumbBytes(photo, processing);

    const files = await readdir(join(cacheDir, "cache", "thumbs"));
    expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("propagates the processor's error so runSweep can classify it", async () => {
    const err = Object.assign(new Error("unreadable"), { code: "EIO" });
    const processing = {
      thumbnail: vi.fn().mockRejectedValue(err),
      videoThumb: vi.fn(),
    };

    await expect(thumbBytes(photo, processing)).rejects.toMatchObject({
      code: "EIO",
    });
  });
});
