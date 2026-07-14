import { describe, it, expect } from "vitest";
import {
  selectState,
  intersectionCount,
  needsSelectConfirm,
  BIG_GROUP_SELECT,
} from "./groupSelection.js";

describe("selectState", () => {
  it("is 'none' for an empty group", () => {
    expect(selectState(0, 0)).toBe("none");
  });

  it("is 'none' when nothing in the group is selected", () => {
    expect(selectState(0, 10)).toBe("none");
  });

  it("is 'some' when part of the group is selected", () => {
    expect(selectState(1, 10)).toBe("some");
    expect(selectState(9, 10)).toBe("some");
  });

  it("is 'all' when exactly every photo is selected", () => {
    expect(selectState(10, 10)).toBe("all");
    expect(selectState(1, 1)).toBe("all");
  });

  it("clamps to 'all' if the count somehow exceeds the group size", () => {
    // defensive: a stale over-count must not read as 'some'
    expect(selectState(11, 10)).toBe("all");
  });

  it("treats a negative/garbage selected count as 'none'", () => {
    expect(selectState(-1, 10)).toBe("none");
  });
});

describe("intersectionCount", () => {
  it("counts how many ids are present in the selection set", () => {
    const selected = new Set([2, 4, 6, 8]);
    expect(intersectionCount([1, 2, 3, 4, 5], selected)).toBe(2);
  });

  it("is 0 for an empty id list or empty selection", () => {
    expect(intersectionCount([], new Set([1, 2]))).toBe(0);
    expect(intersectionCount([1, 2], new Set())).toBe(0);
  });

  it("counts every id when all are selected", () => {
    expect(intersectionCount([1, 2, 3], new Set([1, 2, 3, 9]))).toBe(3);
  });

  it("does not double-count duplicate ids beyond their presence", () => {
    // ids should be unique in practice; duplicates each still count as present
    expect(intersectionCount([1, 1, 2], new Set([1, 2]))).toBe(3);
  });
});

describe("needsSelectConfirm", () => {
  it("does not ask for the sizes a real click usually means — a card, a shoot, a day", () => {
    expect(needsSelectConfirm(1)).toBe(false);
    expect(needsSelectConfirm(300)).toBe(false);
    expect(needsSelectConfirm(BIG_GROUP_SELECT)).toBe(false);
  });

  it("asks once a single click would take more than the threshold", () => {
    // Clicking a folder takes the folders under it too, so one click near the
    // root of a real library is worth tens of thousands of photos — and it sits
    // right next to the folder's name, where you click to LOOK at it.
    expect(needsSelectConfirm(BIG_GROUP_SELECT + 1)).toBe(true);
    expect(needsSelectConfirm(114_125)).toBe(true);
  });

  it("is not asked of an empty group", () => {
    expect(needsSelectConfirm(0)).toBe(false);
  });
});
