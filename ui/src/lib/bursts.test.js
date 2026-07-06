import { describe, it, expect } from "vitest";
import { detectBursts } from "./bursts.js";

describe("detectBursts", () => {
  it("groups consecutive photos within gapMs, and splits on a wider gap", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0 },
      { id: 2, name: "b.jpg", mtimeMs: 500 },
      { id: 3, name: "c.jpg", mtimeMs: 900 },
      { id: 4, name: "d.jpg", mtimeMs: 10000 }, // far away, stays alone
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks).toHaveLength(1);
    expect(stacks[0].memberIds).toEqual([1, 2, 3]);
    expect(stacks[0].count).toBe(3);
  });

  it("keeps same-burst-filename photos grouped even if their gap exceeds gapMs", () => {
    const items = [
      { id: 1, name: "PXL_20240101_000000000.BURST-01.COVER.jpg", mtimeMs: 0 },
      { id: 2, name: "PXL_20240101_000000000.BURST-02.jpg", mtimeMs: 5000 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks).toHaveLength(1);
    expect(stacks[0].memberIds).toEqual([1, 2]);
  });

  it("picks the highest-rated member as cover, even over a filename COVER marker", () => {
    const items = [
      { id: 1, name: "PXL_1.BURST-01.COVER.jpg", mtimeMs: 0, rating: 0 },
      { id: 2, name: "PXL_1.BURST-02.jpg", mtimeMs: 200, rating: 4 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks[0].coverId).toBe(2);
  });

  it("picks the COVER-marked file when no member is rated", () => {
    const items = [
      { id: 1, name: "PXL_1.BURST-01.jpg", mtimeMs: 0 },
      { id: 2, name: "PXL_1.BURST-02.COVER.jpg", mtimeMs: 200 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks[0].coverId).toBe(2);
  });

  it("picks the chronologically-first member when neither rating nor COVER marker applies", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 200 },
      { id: 2, name: "b.jpg", mtimeMs: 0 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks[0].coverId).toBe(2); // mtimeMs 0 is chronologically first
  });

  it("prefers takenAt over mtimeMs for grouping when takenAt is present", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0, takenAt: 0 },
      // mtimeMs is far apart (file copied later), but takenAt (actual
      // capture time) is close — grouping must follow takenAt.
      { id: 2, name: "b.jpg", mtimeMs: 50000, takenAt: 200 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks).toHaveLength(1);
    expect(stacks[0].memberIds).toEqual([1, 2]);
  });

  it("falls back to mtimeMs when takenAt is missing", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0 },
      { id: 2, name: "b.jpg", mtimeMs: 300 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks).toHaveLength(1);
    expect(stacks[0].memberIds).toEqual([1, 2]);
  });

  it("does not create a stack for a lone photo with no time-adjacent neighbor or burst partner", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0 },
      { id: 2, name: "b.jpg", mtimeMs: 100000 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks).toHaveLength(0);
  });

  it("partitions a mixed folder into ungrouped photos, a time-gap cluster, and a filename cluster", () => {
    const items = [
      { id: 1, name: "solo.jpg", mtimeMs: 0 },
      { id: 2, name: "tg-a.jpg", mtimeMs: 100000 },
      { id: 3, name: "tg-b.jpg", mtimeMs: 100300 },
      { id: 4, name: "PXL_1.BURST-01.COVER.jpg", mtimeMs: 500000 },
      { id: 5, name: "PXL_1.BURST-02.jpg", mtimeMs: 500200 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks).toHaveLength(2);
    const memberIdSets = stacks.map((s) => [...s.memberIds].sort());
    expect(memberIdSets).toContainEqual([2, 3]);
    expect(memberIdSets).toContainEqual([4, 5]);
    const allGrouped = stacks.flatMap((s) => s.memberIds);
    expect(allGrouped).not.toContain(1);
  });
});
