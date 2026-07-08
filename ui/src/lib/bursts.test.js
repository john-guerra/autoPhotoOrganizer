import { describe, it, expect } from "vitest";
import { detectBursts, detectBurstsByGroup } from "./bursts.js";

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

  it("keeps a stack's id stable when a rating changes which member is the cover", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0 },
      { id: 2, name: "b.jpg", mtimeMs: 200 },
      { id: 3, name: "c.jpg", mtimeMs: 400 },
    ];
    const before = detectBursts(items, { gapMs: 1000 });
    expect(before).toHaveLength(1);
    const stackIdBefore = before[0].id;
    expect(before[0].coverId).toBe(1); // no rating yet: chronologically-first is cover

    // Simulate the user rating a different member the highest, as if
    // App.svelte's rate() had mutated the shared item and re-run
    // detectBursts on the same items array.
    items[2].rating = 5; // item id 3
    const after = detectBursts(items, { gapMs: 1000 });
    expect(after).toHaveLength(1);
    expect(after[0].coverId).toBe(3); // cover changed to the newly-rated member
    expect(after[0].id).toBe(stackIdBefore); // but the stack's own id did NOT change
  });

  it("prefers a manually-chosen cover over a higher-rated or COVER-marked member", () => {
    const items = [
      { id: 1, name: "PXL_1.BURST-01.COVER.jpg", mtimeMs: 0, rating: 0 },
      { id: 2, name: "PXL_1.BURST-02.jpg", mtimeMs: 200, rating: 4 },
      {
        id: 3,
        name: "PXL_1.BURST-03.jpg",
        mtimeMs: 400,
        rating: 0,
        preferredCover: true,
      },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks[0].coverId).toBe(3);
  });

  it("keeps a stack's id stable when a manual cover choice is set", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0 },
      { id: 2, name: "b.jpg", mtimeMs: 200 },
      { id: 3, name: "c.jpg", mtimeMs: 400 },
    ];
    const before = detectBursts(items, { gapMs: 1000 });
    const stackIdBefore = before[0].id;
    expect(before[0].coverId).toBe(1);

    items[2].preferredCover = true; // item id 3
    const after = detectBursts(items, { gapMs: 1000 });
    expect(after[0].coverId).toBe(3);
    expect(after[0].id).toBe(stackIdBefore);
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

  it("groups photos using takenAt even when it's an ISO-8601 string (the real app's shape)", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0, takenAt: "2024-01-01T00:00:00.000Z" },
      { id: 2, name: "b.jpg", mtimeMs: 50000, takenAt: "2024-01-01T00:00:00.200Z" },
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

describe("detectBurstsByGroup", () => {
  it("never merges a burst across a group boundary, even when two groups share identical timestamps", () => {
    // Real case from John's archive: two different folders whose photos
    // happen to carry an identical timestamp sequence (a duplicated
    // backup) — a naive whole-window detectBursts call merges them into
    // one cross-folder burst; this must keep them as two separate stacks.
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0, groupValues: { folder: "/A" } },
      { id: 2, name: "b.jpg", mtimeMs: 200, groupValues: { folder: "/A" } },
      { id: 3, name: "c.jpg", mtimeMs: 0, groupValues: { folder: "/B" } },
      { id: 4, name: "d.jpg", mtimeMs: 200, groupValues: { folder: "/B" } },
    ];
    const stacks = detectBurstsByGroup(items, ["folder"], { gapMs: 1000 });
    expect(stacks).toHaveLength(2);
    const memberIdSets = stacks.map((s) => [...s.memberIds].sort());
    expect(memberIdSets).toContainEqual([1, 2]);
    expect(memberIdSets).toContainEqual([3, 4]);
  });

  it("behaves like detectBursts on the whole array when groupBy is empty", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0, groupValues: {} },
      { id: 2, name: "b.jpg", mtimeMs: 200, groupValues: {} },
    ];
    expect(detectBurstsByGroup(items, [], { gapMs: 1000 })).toEqual(
      detectBursts(items, { gapMs: 1000 })
    );
  });
});
