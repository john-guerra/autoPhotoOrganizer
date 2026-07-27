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
      {
        id: 2,
        name: "b.jpg",
        mtimeMs: 50000,
        takenAt: "2024-01-01T00:00:00.200Z",
      },
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

/**
 * The near-duplicate signal (#162). The server's embedding sweep labels photos
 * it judged to be the same shot; that label is a THIRD merge signal here,
 * alongside the time gap and the Pixel filename hard-link.
 *
 * The direction is the property worth protecting: the signal may only ever ADD
 * members to a stack, never remove them. That is what lets a library with no
 * embeddings — the default, since the feature is opt-in — behave exactly as it
 * did before, and what stops a wrong grouping from dissolving a burst the user
 * already relies on.
 */
describe("detectBursts with near-duplicate groups", () => {
  it("keeps same-dupe-group photos together even when their gap exceeds gapMs", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0, dupeGroupId: 7 },
      { id: 2, name: "b.jpg", mtimeMs: 30000, dupeGroupId: 7 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks).toHaveLength(1);
    expect(stacks[0].memberIds).toEqual([1, 2]);
  });

  it("does NOT merge photos beyond gapMs that are in different dupe groups", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0, dupeGroupId: 7 },
      { id: 2, name: "b.jpg", mtimeMs: 30000, dupeGroupId: 8 },
    ];
    expect(detectBursts(items, { gapMs: 1000 })).toHaveLength(0);
  });

  it("treats a null dupe group as no signal, not as a group of its own", () => {
    // Two photos that both have NO grouping must not match each other by
    // virtue of both being null — `null === null` is true in JS, so this is a
    // one-character mistake away and would stack every unembedded photo in the
    // library with its neighbour.
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0, dupeGroupId: null },
      { id: 2, name: "b.jpg", mtimeMs: 30000, dupeGroupId: null },
    ];
    expect(detectBursts(items, { gapMs: 1000 })).toHaveLength(0);
  });

  it("reproduces existing behaviour exactly when no photo carries a group", () => {
    // The no-op guarantee for the default (opt-in off) configuration: absent
    // the field entirely, results must be identical to the same items with it.
    const bare = [
      { id: 1, name: "a.jpg", mtimeMs: 0 },
      { id: 2, name: "b.jpg", mtimeMs: 500 },
      { id: 3, name: "c.jpg", mtimeMs: 10000 },
    ];
    const withNulls = bare.map((it) => ({ ...it, dupeGroupId: null }));
    expect(detectBursts(withNulls, { gapMs: 1000 })).toEqual(
      detectBursts(bare, { gapMs: 1000 })
    );
  });

  it("bridges a burst across an intruding photo that is not part of it", () => {
    // The dupe group is transitive server-side, so frames 1 and 3 carry the
    // same label even though an unrelated shot sits between them in time.
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0, dupeGroupId: 7 },
      { id: 2, name: "intruder.jpg", mtimeMs: 20000, dupeGroupId: null },
      { id: 3, name: "c.jpg", mtimeMs: 40000, dupeGroupId: 7 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    // The walk compares against the running cluster's last member, so the
    // intruder starts its own cluster and 3 cannot rejoin 1. Documented as the
    // known limit of a single-pass walk rather than asserted as desirable: the
    // grouping is still correct, just split.
    expect(stacks).toHaveLength(0);
  });

  it("still respects group partitioning, so a cross-folder pair stays split", () => {
    // The server labels by time and similarity with no idea what the user is
    // grouping by; detectBurstsByGroup partitions FIRST, which is what enforces
    // "within-group only" for free.
    const items = [
      {
        id: 1,
        name: "a.jpg",
        mtimeMs: 0,
        dupeGroupId: 7,
        groupValues: { folder: "A" },
      },
      {
        id: 2,
        name: "b.jpg",
        mtimeMs: 30000,
        dupeGroupId: 7,
        groupValues: { folder: "B" },
      },
    ];
    expect(detectBurstsByGroup(items, ["folder"], { gapMs: 1000 })).toEqual([]);
  });
});

/**
 * The refiner (#216): similarity vetoing a time merge.
 *
 * The reverse of the disjunct above, and the reason it was worth reversing
 * #162's "additive only" rule — measured over 10,424 time-adjacent pairs in a
 * real library, the median similarity inside a 3s gap is 0.677 and the lower
 * quartile 0.508. A quarter of what the gap stacks together is visibly
 * unrelated.
 *
 * Every test here is really about one thing: the veto must fire ONLY when the
 * pair in front of it was actually measured. Splitting a burst on a comparison
 * between the wrong two photos would be worse than never splitting at all.
 */
describe("detectBursts with the similarity refiner", () => {
  const pair = (simPrev, simPrevId) => [
    { id: 1, name: "a.jpg", mtimeMs: 0 },
    { id: 2, name: "b.jpg", mtimeMs: 500, simPrev, simPrevId },
  ];

  it("splits a time-adjacent pair the model says is unrelated", () => {
    const stacks = detectBursts(pair(0.42, 1), {
      gapMs: 1000,
      unrelatedBelow: 0.6,
    });
    expect(stacks).toHaveLength(0);
  });

  it("keeps a time-adjacent pair the model says is related", () => {
    const stacks = detectBursts(pair(0.85, 1), {
      gapMs: 1000,
      unrelatedBelow: 0.6,
    });
    expect(stacks).toHaveLength(1);
  });

  it("leaves the agnostic band to time — between the two bars, nothing changes", () => {
    // 0.7 is below the 0.93 merge bar and above the 0.6 veto bar: the signal
    // is not confident either way, so time's verdict stands.
    expect(
      detectBursts(pair(0.7, 1), { gapMs: 1000, unrelatedBelow: 0.6 })
    ).toHaveLength(1);
  });

  it("does NOT split when the score describes a different pair", () => {
    // simPrevId points at photo 99, not at the photo actually preceding this
    // one in the client's order. Acting on it would compare the wrong two
    // photos, so the veto declines and time wins.
    const stacks = detectBursts(pair(0.1, 99), {
      gapMs: 1000,
      unrelatedBelow: 0.6,
    });
    expect(stacks).toHaveLength(1);
  });

  it("does NOT split when a photo has no score at all", () => {
    // Un-embedded photos have no row, so there is nothing to judge them on —
    // the whole library must keep working before any embedding has run.
    expect(
      detectBursts(pair(null, null), { gapMs: 1000, unrelatedBelow: 0.6 })
    ).toHaveLength(1);
  });

  it("is inert when the caller does not opt in", () => {
    // The default bar is 0, which nothing can score below — so an app that
    // never passes unrelatedBelow behaves exactly as it did before #216.
    expect(detectBursts(pair(0.01, 1), { gapMs: 1000 })).toHaveLength(1);
  });

  it("splits one long run into two where the scene actually changes", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0 },
      { id: 2, name: "b.jpg", mtimeMs: 500, simPrev: 0.97, simPrevId: 1 },
      { id: 3, name: "c.jpg", mtimeMs: 1000, simPrev: 0.35, simPrevId: 2 },
      { id: 4, name: "d.jpg", mtimeMs: 1500, simPrev: 0.96, simPrevId: 3 },
    ];
    const stacks = detectBursts(items, { gapMs: 3000, unrelatedBelow: 0.6 });
    expect(stacks).toHaveLength(2);
    expect(stacks[0].memberIds).toEqual([1, 2]);
    expect(stacks[1].memberIds).toEqual([3, 4]);
  });
});
