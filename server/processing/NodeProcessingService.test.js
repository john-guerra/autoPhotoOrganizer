import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { NodeProcessingService, formatCamera } from "./NodeProcessingService.js";

let dir;
let svc;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ag-processing-"));
  svc = new NodeProcessingService();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scan — RAW file discovery", () => {
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

describe("formatCamera", () => {
  it("combines Make and Model, de-duplicating when Model repeats Make", () => {
    expect(formatCamera("Canon", "Canon EOS R6")).toBe("Canon EOS R6");
    expect(formatCamera("Google", "Pixel 9 Pro")).toBe("Google Pixel 9 Pro");
    expect(formatCamera(undefined, "iPhone 15")).toBe("iPhone 15");
    expect(formatCamera("Sony", undefined)).toBe("Sony");
    expect(formatCamera(undefined, undefined)).toBe("");
  });
});
