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

  it("front(6)/middle(4)/last(2) block sizes and gap positions for a big group", () => {
    const { offsets, gaps } = sampleOffsets(1000, 12);
    expect(offsets).toHaveLength(12);
    // front block: ceil((12-2)*0.6) = 6 indices, 0..5
    expect(offsets.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    // last block: the final two real indices
    expect(offsets.slice(-2)).toEqual([998, 999]);
    // middle block: 12-2-6 = 4 indices strictly between the front and last
    const middle = offsets.slice(6, 10);
    expect(middle).toHaveLength(4);
    for (const idx of middle) {
      expect(idx).toBeGreaterThan(5);
      expect(idx).toBeLessThan(998);
    }
    // strictly increasing, no duplicates, all in range
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
    for (const idx of offsets) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(1000);
    }
    // gaps mark every point where the next offset doesn't immediately
    // follow: front→middle (after index 5), each middle pick (they're
    // spread ~200 apart, not contiguous with each other), and middle→last
    // (after index 9). Only the last block (998,999) is contiguous, so
    // index 10 is NOT a gap.
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
