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

  it("front(6)/middle-cluster(4)/last(2) blocks and two gaps for a big group", () => {
    const { offsets, gaps } = sampleOffsets(1000, 12);
    expect(offsets).toHaveLength(12);
    // front block: ceil((12-2)*0.6) = 6 indices, 0..5
    expect(offsets.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    // middle: a CONTIGUOUS cluster of 12-2-6 = 4 indices, centered in the
    // band [6, 997]. Assert contiguity + rough centering rather than pinning
    // the exact start index.
    const middle = offsets.slice(6, 10);
    expect(middle).toHaveLength(4);
    for (let i = 1; i < middle.length; i++) {
      expect(middle[i]).toBe(middle[i - 1] + 1); // contiguous
    }
    expect(middle[0]).toBeGreaterThan(400);
    expect(middle[3]).toBeLessThan(600); // roughly centered
    // last block: the final two real indices
    expect(offsets.slice(-2)).toEqual([998, 999]);
    // strictly increasing, no duplicates, all in range
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
    for (const idx of offsets) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(1000);
    }
    // exactly two omission gaps: front→middle-cluster (after index 5) and
    // middle-cluster→last (after index 9). The front block, the middle
    // cluster, and the last pair are each internally contiguous.
    expect(gaps).toEqual([5, 9]);
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
