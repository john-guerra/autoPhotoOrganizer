import { describe, it, expect } from "vitest";
import { sampleOffsets } from "./sampleGroup.js";

describe("sampleOffsets", () => {
  it("returns every index with no gaps when the whole group fits", () => {
    expect(sampleOffsets(5, 5)).toEqual({
      offsets: [0, 1, 2, 3, 4],
      gaps: [],
    });
    expect(sampleOffsets(3, 12)).toEqual({
      offsets: [0, 1, 2],
      gaps: [],
    });
  });

  it("evenly distributes across the whole album, first+last included", () => {
    const { offsets, gaps } = sampleOffsets(1000, 12);
    expect(offsets).toHaveLength(12);
    // first and last are always included
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(999);
    // strictly increasing, no duplicates, all in range
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
    // equal strides: every gap between shown thumbs is ~999/11 ≈ 91 (±2 for
    // rounding) — a representative spread, not a contiguous slice.
    for (let i = 1; i < offsets.length; i++) {
      expect(Math.abs(offsets[i] - offsets[i - 1] - 91)).toBeLessThanOrEqual(2);
    }
    // every interior boundary skips photos, so a "…" belongs after each of
    // the first 11 shown thumbs.
    expect(gaps).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("degenerate slots=1 shows just the first", () => {
    expect(sampleOffsets(500, 1)).toEqual({ offsets: [0], gaps: [] });
  });

  it("small slot counts still produce valid, in-range, strictly increasing offsets", () => {
    for (const slots of [3, 4, 5]) {
      const { offsets } = sampleOffsets(1000, slots);
      expect(offsets.length).toBeLessThanOrEqual(slots);
      expect(offsets.length).toBeGreaterThan(0);
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
      }
      for (const idx of offsets) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(1000);
      }
      // no duplicates
      expect(new Set(offsets).size).toBe(offsets.length);
    }
  });

  it("count just above slots still returns that many distinct in-range offsets", () => {
    const { offsets } = sampleOffsets(13, 12);
    expect(offsets).toHaveLength(12);
    expect(new Set(offsets).size).toBe(12);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
    for (const idx of offsets) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(13);
    }
  });

  it("handles empty/degenerate input", () => {
    expect(sampleOffsets(0, 12)).toEqual({ offsets: [], gaps: [] });
    expect(sampleOffsets(10, 0)).toEqual({ offsets: [], gaps: [] });
  });
});
