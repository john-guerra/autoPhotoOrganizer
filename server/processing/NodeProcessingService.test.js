import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import {
  NodeProcessingService,
  formatCamera,
  exifToMeta,
} from "./NodeProcessingService.js";

let dir;
let svc;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ag-processing-"));
  svc = new NodeProcessingService();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scan — media file discovery", () => {
  it("discovers RAW extensions with kind:'raw', existing formats with kind:'image'", async () => {
    await writeFile(join(dir, "a.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(join(dir, "b.cr2"), Buffer.from([0]));
    await writeFile(join(dir, "c.NEF"), Buffer.from([0])); // case-insensitive
    await writeFile(join(dir, "d.txt"), Buffer.from([0])); // not media, skipped

    const files = await svc.scan(dir);
    const byName = Object.fromEntries(files.map((f) => [f.name, f.kind]));
    expect(byName).toEqual({
      "a.jpg": "image",
      "b.cr2": "raw",
      "c.NEF": "raw",
    });
    expect(files.some((f) => f.name === "d.txt")).toBe(false);
  });

  it("discovers video extensions with kind:'video' (case-insensitive)", async () => {
    await writeFile(join(dir, "clip.mp4"), Buffer.from([0]));
    await writeFile(join(dir, "trip.MOV"), Buffer.from([0])); // case-insensitive
    await writeFile(join(dir, "cam.mkv"), Buffer.from([0]));
    await writeFile(join(dir, "notes.txt"), Buffer.from([0])); // skipped

    const files = await svc.scan(dir);
    const byName = Object.fromEntries(files.map((f) => [f.name, f.kind]));
    expect(byName).toEqual({
      "clip.mp4": "video",
      "trip.MOV": "video",
      "cam.mkv": "video",
    });
    expect(files.some((f) => f.name === "notes.txt")).toBe(false);
  });
});

describe("thumbnail — RAW guard", () => {
  it("throws RawDecodeUnavailableError for a RAW extension, without attempting a sharp decode", async () => {
    const raw = join(dir, "photo.cr2");
    await writeFile(raw, Buffer.from([0])); // not valid image data — if sharp were
    // attempted, it would throw a DIFFERENT (generic decode-failure) error, not this one
    await expect(svc.thumbnail(raw, 320)).rejects.toThrow(/RAW/);
    await expect(svc.thumbnail(raw, 320)).rejects.toMatchObject({
      name: "RawDecodeUnavailableError",
    });
  });

  it("still fully decodes a real JPEG (regression check)", async () => {
    const jpg = join(dir, "photo.jpg");
    await sharp({
      create: { width: 400, height: 300, channels: 3, background: "red" },
    })
      .jpeg()
      .toFile(jpg);
    const result = await svc.thumbnail(jpg, 100);
    expect(result.source).toBe("decoded");
    expect(result.width).toBeLessThanOrEqual(100);
  });
});

describe("extractPreview", () => {
  it("returns null for a file with no embedded EXIF thumbnail", async () => {
    const jpg = join(dir, "no-exif.jpg");
    await sharp({
      create: { width: 200, height: 150, channels: 3, background: "blue" },
    })
      .jpeg()
      .toFile(jpg);
    // A synthetically-created JPEG carries no EXIF/thumbnail segment — this
    // exercises the "no embedded preview" branch. Extracting a REAL embedded
    // thumbnail needs a genuine camera-sourced fixture, which this project's
    // established testing convention defers to live manual validation
    // (Task 6) rather than constructing one by hand — see the design spec's
    // own note on this.
    const result = await svc.extractPreview(jpg);
    expect(result).toBeNull();
  });

  it("propagates a genuine I/O error for an unreadable file", async () => {
    await expect(
      svc.extractPreview(join(dir, "does-not-exist.jpg"))
    ).rejects.toThrow();
  });
});

// ffmpeg-static downloads its binary at install time; if that was skipped (e.g.
// an offline/locked-down CI), degrade gracefully rather than fail — matching the
// project's "defer to manual validation" convention for fixtures it can't build.
async function ffmpegAvailable() {
  if (!ffmpegPath) return false;
  return new Promise((resolve) => {
    const c = spawn(ffmpegPath, ["-version"], { stdio: "ignore" });
    c.on("error", () => resolve(false));
    c.on("close", (code) => resolve(code === 0));
  });
}

/** Generate a real N-second test clip with the bundled ffmpeg. */
function makeClip(path, seconds = 2) {
  return new Promise((resolve, reject) => {
    const c = spawn(
      ffmpegPath,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `testsrc=duration=${seconds}:size=320x240:rate=10`,
        path,
      ],
      { stdio: "ignore" }
    );
    c.on("error", reject);
    c.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg gen exit ${code}`))
    );
  });
}

describe("videoThumb + video metadata (ffmpeg/ffprobe)", () => {
  let hasFfmpeg;
  beforeAll(async () => {
    hasFfmpeg = await ffmpegAvailable();
  });

  it("videoThumb extracts a size-bounded JPEG poster frame", async () => {
    if (!hasFfmpeg) return; // skip when the static binary is unavailable
    const mp4 = join(dir, "clip.mp4");
    await makeClip(mp4, 2);
    const result = await svc.videoThumb(mp4, 100);
    expect(result.source).toBe("decoded");
    expect(result.width).toBeLessThanOrEqual(100);
    expect(result.height).toBeLessThanOrEqual(100);
    // JPEG SOI magic bytes.
    expect(result.data[0]).toBe(0xff);
    expect(result.data[1]).toBe(0xd8);
  });

  it("metadata reads duration + displayed dimensions for a video", async () => {
    if (!hasFfmpeg) return;
    const mp4 = join(dir, "clip.mp4");
    await makeClip(mp4, 2);
    const [meta] = await svc.metadata([mp4]);
    expect(meta.duration).toBeGreaterThan(1.5);
    expect(meta.duration).toBeLessThan(2.6);
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(240);
    // lavfi sets no creation_time → undated, camera is "" (satisfies the
    // meta re-try sentinel so it isn't re-probed forever).
    expect(meta.createDate).toBeUndefined();
    expect(meta.camera).toBe("");
  });

  it("videoThumb rejects with VideoDecodeError for a non-video file", async () => {
    if (!hasFfmpeg) return;
    const fake = join(dir, "bogus.mp4");
    await writeFile(fake, Buffer.from("not actually a video"));
    await expect(svc.videoThumb(fake, 100)).rejects.toMatchObject({
      name: "VideoDecodeError",
    });
  });
});

describe("formatCamera", () => {
  it("combines Make and Model, de-duplicating when Model repeats Make", () => {
    expect(formatCamera("Canon", "Canon EOS R6")).toBe("Canon EOS R6");
    expect(formatCamera("Google", "Pixel 9 Pro")).toBe("Google Pixel 9 Pro");
    expect(formatCamera(undefined, "iPhone 15")).toBe("iPhone 15");
    expect(formatCamera("Sony", undefined)).toBe("Sony");
    expect(formatCamera(undefined, undefined)).toBe("");
  });
});

describe("exifToMeta", () => {
  it("maps exifr fields to raw persisted values", () => {
    expect(
      exifToMeta({
        FNumber: 2.8,
        ExposureTime: 0.004,
        ISO: 400,
        FocalLength: 50,
        LensModel: "RF24-70mm F2.8 L IS USM",
      })
    ).toEqual({
      aperture: 2.8,
      shutter: 0.004,
      iso: 400,
      focalLength: 50,
      lens: "RF24-70mm F2.8 L IS USM",
      lat: null,
      lon: null,
    });
  });

  it("returns nulls and an empty-string lens sentinel when EXIF is absent", () => {
    expect(exifToMeta(undefined)).toEqual({
      aperture: null,
      shutter: null,
      iso: null,
      focalLength: null,
      lens: "",
      lat: null,
      lon: null,
    });
  });
});
