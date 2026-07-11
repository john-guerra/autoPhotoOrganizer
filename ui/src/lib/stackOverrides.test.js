import { describe, it, expect } from "vitest";
import { applyStackOverrides, canCreateManualStack } from "./stackOverrides.js";
import { buildDisplayEntries } from "./displayEntries.js";

/** Minimal item factory. */
function item(id, extra = {}) {
  return { id, name: `${id}.jpg`, rating: 0, ...extra };
}

describe("applyStackOverrides — keepSeparate (dissolve)", () => {
  it("splits one kept-separate member out of a 3-member auto stack", () => {
    const items = [item(1), item(2, { keepSeparate: true }), item(3)];
    const auto = [
      { id: "burst-1", memberIds: [1, 2, 3], coverId: 1, count: 3 },
    ];
    const stacks = applyStackOverrides(auto, items);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].memberIds).toEqual([1, 3]);
    expect(stacks[0].count).toBe(2);
  });

  it("dissolves the stack entirely when survivors drop below 2", () => {
    const items = [
      item(1, { keepSeparate: true }),
      item(2, { keepSeparate: true }),
      item(3),
    ];
    const auto = [
      { id: "burst-1", memberIds: [1, 2, 3], coverId: 1, count: 3 },
    ];
    expect(applyStackOverrides(auto, items)).toEqual([]);
  });
});

describe("applyStackOverrides — manual grouping", () => {
  it("forces non-adjacent photos (no auto stack) into one manual stack", () => {
    const items = [
      item(1, { manualStackId: 7 }),
      item(2),
      item(3, { manualStackId: 7 }),
    ];
    const stacks = applyStackOverrides([], items);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].id).toBe("manual-7");
    expect(stacks[0].memberIds).toEqual([1, 3]);
    expect(stacks[0].count).toBe(2);
  });

  it("pulls manual members out of an overlapping auto stack", () => {
    const items = [
      item(1, { manualStackId: 9 }),
      item(2),
      item(3, { manualStackId: 9 }),
    ];
    const auto = [{ id: "burst-1", memberIds: [1, 2], coverId: 1, count: 2 }];
    const stacks = applyStackOverrides(auto, items);
    // Auto stack loses member 1 → only member 2 left → dissolved; manual 1+3 forms.
    const ids = stacks.map((s) => s.id).sort();
    expect(ids).toEqual(["manual-9"]);
    expect(stacks[0].memberIds).toEqual([1, 3]);
  });

  it("uses the canonical cover priority for a manual stack", () => {
    const items = [
      item(1, { manualStackId: 3 }),
      item(2, { manualStackId: 3, rating: 5 }),
    ];
    const stacks = applyStackOverrides([], items);
    expect(stacks[0].coverId).toBe(2);
  });

  it("does NOT render a manual group with only 1 present member as a stack", () => {
    const items = [item(1, { manualStackId: 5 })]; // its partner is outside the window
    expect(applyStackOverrides([], items)).toEqual([]);
  });
});

describe("applyStackOverrides — positioning via buildDisplayEntries", () => {
  it("a manual stack lands at its first member's position, others unmoved", () => {
    const items = [
      item(1),
      item(2, { manualStackId: 4 }),
      item(3),
      item(4, { manualStackId: 4 }),
    ];
    const stacks = applyStackOverrides([], items);
    const entries = buildDisplayEntries(items, stacks, new Set());
    // photo 1, then the stack (anchored at photo 2), then photo 3. Photo 4 folded in.
    expect(
      entries.map((e) => (e.kind === "stack" ? e.stack.id : e.item.id))
    ).toEqual([1, "manual-4", 3]);
  });
});

describe("canCreateManualStack", () => {
  const items = [
    item(1, { groupValues: { folder: "/a" } }),
    item(2, { groupValues: { folder: "/a" } }),
    item(3, { groupValues: { folder: "/b" } }),
  ];
  it("true for ≥2 photos in one group", () => {
    expect(canCreateManualStack(items, new Set([1, 2]), ["folder"])).toBe(true);
  });
  it("false when the selection spans groups", () => {
    expect(canCreateManualStack(items, new Set([1, 3]), ["folder"])).toBe(
      false
    );
  });
  it("false for fewer than 2", () => {
    expect(canCreateManualStack(items, new Set([1]), ["folder"])).toBe(false);
  });
  it("false when a selected id isn't in the window", () => {
    expect(canCreateManualStack(items, new Set([1, 99]), ["folder"])).toBe(
      false
    );
  });
});
