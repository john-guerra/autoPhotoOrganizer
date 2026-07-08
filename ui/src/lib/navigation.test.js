import { describe, it, expect } from "vitest";
import { nextSelectable, nearestBoxInAdjacentRow, navVertical } from "./navigation.js";

describe("nextSelectable", () => {
  it("returns the starting index when it's already selectable", () => {
    const entries = [{ kind: "photo" }, { kind: "photo" }];
    expect(nextSelectable(entries, 0, 1)).toBe(0);
  });

  it("skips forward past placeholders", () => {
    const entries = [
      { kind: "placeholder" },
      { kind: "placeholder" },
      { kind: "photo" },
    ];
    expect(nextSelectable(entries, 0, 1)).toBe(2);
  });

  it("skips backward past placeholders", () => {
    const entries = [{ kind: "photo" }, { kind: "placeholder" }, { kind: "placeholder" }];
    expect(nextSelectable(entries, 2, -1)).toBe(0);
  });

  it("returns null when every remaining entry in that direction is a placeholder", () => {
    const entries = [{ kind: "photo" }, { kind: "placeholder" }, { kind: "placeholder" }];
    expect(nextSelectable(entries, 1, 1)).toBeNull();
  });
});

describe("nearestBoxInAdjacentRow", () => {
  const boxes = [
    { x: 0, y: 0, width: 100, height: 100 }, // 0: row 0
    { x: 100, y: 0, width: 100, height: 100 }, // 1: row 0
    { x: 0, y: 100, width: 100, height: 100 }, // 2: row 1
    { x: 100, y: 100, width: 50, height: 100 }, // 3: row 1
    { x: 150, y: 100, width: 100, height: 100 }, // 4: row 1
  ];

  it("finds the box in the next row with the nearest horizontal centre", () => {
    // box 1's centre is x=150; row 1's boxes have centres 50, 125, 200 —
    // nearest to 150 is box 4 (centre 200)... but 125 (box 3) is closer.
    expect(nearestBoxInAdjacentRow(boxes, 1, 1)).toBe(3);
  });

  it("finds the box in the previous row with the nearest horizontal centre", () => {
    expect(nearestBoxInAdjacentRow(boxes, 3, -1)).toBe(1);
  });

  it("returns null when already on the last row (dir=1)", () => {
    expect(nearestBoxInAdjacentRow(boxes, 3, 1)).toBeNull();
  });

  it("returns null when already on the first row (dir=-1)", () => {
    expect(nearestBoxInAdjacentRow(boxes, 0, -1)).toBeNull();
  });

  it("returns null for an out-of-range fromIndex", () => {
    expect(nearestBoxInAdjacentRow(boxes, 99, 1)).toBeNull();
  });
});

describe("navVertical", () => {
  const boxes = [
    { x: 0, y: 0, width: 100, height: 100 }, // 0
    { x: 0, y: 100, width: 100, height: 100 }, // 1: placeholder row
    { x: 0, y: 200, width: 100, height: 100 }, // 2
  ];

  it("returns selected unchanged when boxes is null", () => {
    expect(navVertical(null, [], 5, 1)).toBe(5);
  });

  it("moves to the adjacent row's nearest box", () => {
    const entries = [{ kind: "photo" }, { kind: "photo" }, { kind: "photo" }];
    expect(navVertical(boxes, entries, 0, 1)).toBe(1);
  });

  it("skips a placeholder row and keeps advancing in the same direction", () => {
    const entries = [{ kind: "photo" }, { kind: "placeholder" }, { kind: "photo" }];
    expect(navVertical(boxes, entries, 0, 1)).toBe(2);
  });

  it("keeps the original selection when there's no further row that direction", () => {
    const entries = [{ kind: "photo" }, { kind: "photo" }, { kind: "photo" }];
    expect(navVertical(boxes, entries, 2, 1)).toBe(2);
  });
});
