import { describe, it, expect } from "vitest";
import {
  parseStoredSelection,
  toggleId,
  withIds,
  withoutIds,
  rangeIds,
  needsRangeConfirm,
  RANGE_SELECT_CONFIRM,
} from "./selectionOps.js";

describe("parseStoredSelection", () => {
  it("round-trips a persisted id array", () => {
    expect(parseStoredSelection(JSON.stringify([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it("returns [] for a missing value", () => {
    expect(parseStoredSelection(null)).toEqual([]);
    expect(parseStoredSelection(undefined)).toEqual([]);
    expect(parseStoredSelection("null")).toEqual([]);
  });

  it("returns [] for corrupt JSON instead of throwing", () => {
    expect(parseStoredSelection("{not json")).toEqual([]);
  });

  it("returns [] when the stored value isn't an array", () => {
    expect(parseStoredSelection(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(parseStoredSelection(JSON.stringify(42))).toEqual([]);
  });

  it("drops non-integer entries a hand-edited value might carry", () => {
    expect(
      parseStoredSelection(JSON.stringify([1, "2", 3.5, null, 4]))
    ).toEqual([1, 4]);
  });
});

describe("toggleId", () => {
  it("adds an absent id", () => {
    expect([...toggleId(new Set([1]), 2)]).toEqual([1, 2]);
  });

  it("removes a present id", () => {
    expect([...toggleId(new Set([1, 2]), 2)]).toEqual([1]);
  });

  it("returns a NEW set, never mutating the input (reactivity contract)", () => {
    const original = new Set([1]);
    const next = toggleId(original, 2);
    expect(next).not.toBe(original);
    expect([...original]).toEqual([1]);
  });

  it("is a no-op new set for a non-integer id", () => {
    const original = new Set([1]);
    const next = toggleId(original, undefined);
    expect(next).not.toBe(original);
    expect([...next]).toEqual([1]);
  });
});

describe("withIds (union, accumulate-don't-fight)", () => {
  it("adds new ids without removing existing ones", () => {
    expect([...withIds(new Set([1, 2]), [2, 3, 4])]).toEqual([1, 2, 3, 4]);
  });

  it("ignores non-integer ids", () => {
    expect([...withIds(new Set([1]), [2, "3", null, 4.5])]).toEqual([1, 2]);
  });

  it("does not mutate the input set", () => {
    const original = new Set([1]);
    withIds(original, [2, 3]);
    expect([...original]).toEqual([1]);
  });

  it("accepts any iterable of ids", () => {
    expect([...withIds(new Set(), new Set([5, 6]))]).toEqual([5, 6]);
  });
});

describe("withoutIds (remove)", () => {
  it("removes the given ids", () => {
    expect([...withoutIds(new Set([1, 2, 3]), [2, 3])]).toEqual([1]);
  });

  it("ignores ids that aren't in the set", () => {
    expect([...withoutIds(new Set([1, 2]), [3, 4])]).toEqual([1, 2]);
  });

  it("does not mutate the input set", () => {
    const original = new Set([1, 2]);
    withoutIds(original, [2]);
    expect([...original]).toEqual([1, 2]);
  });
});

describe("rangeIds (shift-click range)", () => {
  const photos = [{ id: 10 }, { id: 20 }, { id: 30 }, { id: 40 }];

  it("returns ids for the inclusive span", () => {
    expect(rangeIds(photos, 1, 2)).toEqual([20, 30]);
  });

  it("is order-independent in its endpoints", () => {
    expect(rangeIds(photos, 2, 1)).toEqual([20, 30]);
  });

  it("includes both endpoints", () => {
    expect(rangeIds(photos, 0, 3)).toEqual([10, 20, 30, 40]);
  });

  it("skips slots with no photo or no numeric id (collapsed stacks, gaps)", () => {
    const withGaps = [{ id: 10 }, null, { id: 30 }, { name: "no-id" }];
    expect(rangeIds(withGaps, 0, 3)).toEqual([10, 30]);
  });

  it("handles a single-slot range", () => {
    expect(rangeIds(photos, 2, 2)).toEqual([30]);
  });
});

describe("needsRangeConfirm (shift-click range confirmation)", () => {
  it("does not ask for a range at or below the threshold", () => {
    expect(needsRangeConfirm(1)).toBe(false);
    expect(needsRangeConfirm(RANGE_SELECT_CONFIRM)).toBe(false);
  });

  it("asks once the range exceeds the threshold", () => {
    expect(needsRangeConfirm(RANGE_SELECT_CONFIRM + 1)).toBe(true);
    expect(needsRangeConfirm(500)).toBe(true);
  });
});
