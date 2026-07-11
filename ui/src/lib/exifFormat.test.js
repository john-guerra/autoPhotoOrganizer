import { describe, it, expect } from "vitest";
import {
  formatAperture,
  formatShutter,
  formatIso,
  formatFocal,
  formatSize,
  formatDimensions,
} from "./exifFormat.js";

describe("exifFormat", () => {
  it("apertures: integer stays whole, fraction to one decimal", () => {
    expect(formatAperture(2.8)).toBe("ƒ/2.8");
    expect(formatAperture(8)).toBe("ƒ/8");
    expect(formatAperture(null)).toBe("");
    expect(formatAperture(0)).toBe("");
  });
  it("shutter: sub-second as 1/N, ≥1s as seconds", () => {
    expect(formatShutter(0.004)).toBe("1/250 s");
    expect(formatShutter(0.5)).toBe("1/2 s");
    expect(formatShutter(2)).toBe("2 s");
    expect(formatShutter(1.5)).toBe("1.5 s");
    expect(formatShutter(null)).toBe("");
  });
  it("iso / focal / size / dimensions", () => {
    expect(formatIso(400)).toBe("ISO 400");
    expect(formatIso(0)).toBe("");
    expect(formatFocal(50)).toBe("50 mm");
    expect(formatFocal(null)).toBe("");
    expect(formatSize(2400000)).toBe("2.4 MB");
    expect(formatSize(50000)).toBe("50 KB");
    expect(formatSize(0)).toBe("");
    expect(formatDimensions(3024, 4032)).toBe("3024 × 4032");
    expect(formatDimensions(0, 0)).toBe("");
  });
});
