import { describe, it, expect } from "vitest";
import { gpsFromExif } from "./exifGps.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import exifr from "exifr";
import { exifToMeta } from "../processing/NodeProcessingService.js";
import { withDateAndGps } from "../../e2e/gpsJpeg.mjs";

describe("gpsFromExif", () => {
  it("reads exifr's merged decimal latitude/longitude", () => {
    expect(gpsFromExif({ latitude: 4.711, longitude: -74.0721 })).toEqual({
      lat: 4.711,
      lon: -74.0721,
    });
  });

  it("returns nulls when the photo has no GPS", () => {
    expect(gpsFromExif({ Make: "Canon" })).toEqual({ lat: null, lon: null });
  });

  it("returns nulls for undefined/null EXIF (no EXIF block at all)", () => {
    expect(gpsFromExif(undefined)).toEqual({ lat: null, lon: null });
    expect(gpsFromExif(null)).toEqual({ lat: null, lon: null });
  });

  it("rejects out-of-range and non-finite coordinates", () => {
    expect(gpsFromExif({ latitude: 91, longitude: 0 })).toEqual({
      lat: null,
      lon: null,
    });
    expect(gpsFromExif({ latitude: 0, longitude: 181 })).toEqual({
      lat: null,
      lon: null,
    });
    expect(gpsFromExif({ latitude: NaN, longitude: 10 })).toEqual({
      lat: null,
      lon: null,
    });
    expect(gpsFromExif({ latitude: "4.7", longitude: -74 })).toEqual({
      lat: null,
      lon: null,
    });
  });

  it("keeps 0,0 — Null Island is a real coordinate, not a missing one", () => {
    expect(gpsFromExif({ latitude: 0, longitude: 0 })).toEqual({
      lat: 0,
      lon: 0,
    });
  });
});

const PICK = [
  "DateTimeOriginal",
  "CreateDate",
  "Make",
  "Model",
  "FNumber",
  "ExposureTime",
  "ISO",
  "FocalLength",
  "LensModel",
  "GPSLatitude",
  "GPSLongitude",
  "GPSLatitudeRef",
  "GPSLongitudeRef",
];

describe("GPS through the real exifr call", () => {
  it("extracts lat/lon AND the capture date using the app's own pick list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gps-"));
    const file = join(dir, "geo.jpg");
    const base = await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#1a5aa0" },
    })
      .jpeg()
      .toBuffer();
    writeFileSync(
      file,
      withDateAndGps(base, {
        date: "2024:01:10 09:05:00",
        lat: 4.711,
        lon: -74.0721,
      })
    );

    const exif = await exifr.parse(file, { pick: PICK });
    const meta = exifToMeta(exif);
    expect(meta.lat).toBeCloseTo(4.711, 4);
    expect(meta.lon).toBeCloseTo(-74.0721, 4);
    // The date must survive too: the fixture writes ONE Exif segment holding
    // both, and a reader that took only the first IFD would lose one of them.
    expect(exif.DateTimeOriginal).toBeInstanceOf(Date);
  });

  it("a JPEG with no GPS yields null lat/lon, not undefined", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gps-"));
    const file = join(dir, "plain.jpg");
    const base = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#000" },
    })
      .jpeg()
      .toBuffer();
    writeFileSync(file, base);
    const exif = await exifr.parse(file, { pick: PICK });
    expect(exifToMeta(exif)).toMatchObject({ lat: null, lon: null });
  });
});
