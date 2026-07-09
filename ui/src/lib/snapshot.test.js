import { describe, it, expect } from "vitest";
import { sampleOffsets, slotCount } from "./snapshot.js";

describe("sampleOffsets (client twin of server/db/sampleGroup.js)", () => {
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

  it("front(6)/middle(4)/last(2) block sizes and gap positions for a big group", () => {
    const { offsets, gaps } = sampleOffsets(1000, 12);
    expect(offsets).toHaveLength(12);
    expect(offsets.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(offsets.slice(-2)).toEqual([998, 999]);
    const middle = offsets.slice(6, 10);
    expect(middle).toHaveLength(4);
    for (const idx of middle) {
      expect(idx).toBeGreaterThan(5);
      expect(idx).toBeLessThan(998);
    }
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
    for (const idx of offsets) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(1000);
    }
    // See server/db/sampleGroup.test.js for why every index 5..9 is a gap.
    expect(gaps).toEqual([5, 6, 7, 8, 9]);
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

describe("slotCount", () => {
  it("floors (width + gap) / (thumb + gap), minimum 1", () => {
    expect(slotCount(1000, 110, 4)).toBe(Math.floor(1004 / 114));
    expect(slotCount(114, 110, 4)).toBe(1);
    expect(slotCount(0, 110, 4)).toBe(1); // never goes below 1 slot
    expect(slotCount(228, 110, 4)).toBe(2);
  });
});
