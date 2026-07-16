import { describe, it, expect } from "vitest";
import {
  buildManifest,
  countToY,
  yToCount,
  landmarkAtCount,
  axisScale,
  thinLabels,
  landmarkLabel,
} from "./scale.js";

const flat = {
  total: 10,
  leaves: [
    { values: { year: "2009", month: "01" }, count: 3 },
    { values: { year: "2009", month: "02" }, count: 5 },
    { values: { year: "2010", month: "01" }, count: 2 },
  ],
};

describe("buildManifest", () => {
  it("collapses leaves to coarsest-dim landmarks with cumulative starts", () => {
    const m = buildManifest(flat, { groupBy: ["year", "month"] });
    expect(m.total).toBe(10);
    expect(m.landmarks.map((l) => [l.value, l.startCount, l.count])).toEqual([
      ["2009", 0, 8],
      ["2010", 8, 2],
    ]);
    // path is what jumpToPath consumes: [{ dimension, value }]
    expect(m.landmarks[0].path).toEqual([{ dimension: "year", value: "2009" }]);
    // prefix sums over the leaves (length n+1)
    expect(m.cumStart).toEqual([0, 3, 8, 10]);
  });
});

describe("countToY / yToCount", () => {
  it("maps cumulative count to rail y and back", () => {
    expect(countToY(0, 10, 200)).toBe(0);
    expect(countToY(5, 10, 200)).toBe(100);
    expect(countToY(10, 10, 200)).toBe(200);
    expect(yToCount(100, 10, 200)).toBe(5);
  });

  it("is safe when total is 0 (empty feed)", () => {
    expect(countToY(0, 0, 200)).toBe(0);
    expect(yToCount(50, 0, 200)).toBe(0);
  });
});

describe("landmarkAtCount", () => {
  it("finds the landmark whose count range contains n", () => {
    const m = buildManifest(flat, { groupBy: ["year", "month"] });
    expect(landmarkAtCount(m, 0).value).toBe("2009");
    expect(landmarkAtCount(m, 7).value).toBe("2009");
    expect(landmarkAtCount(m, 8).value).toBe("2010");
    expect(landmarkAtCount(m, 999).value).toBe("2010"); // clamps to last
  });
});

describe("axisScale value axis", () => {
  const m = {
    total: 10,
    landmarks: [
      { value: "2009", startCount: 0, count: 8 },
      { value: "2010", startCount: 8, count: 2 },
    ],
  };
  it("positions by value when valueOf is finite", () => {
    const s = axisScale("value", m, 200, { valueOf: (l) => Number(l.value) });
    expect(s.toY(m.landmarks[0])).toBe(0); // 2009 -> min -> top
    expect(s.toY(m.landmarks[1])).toBe(200); // 2010 -> max -> bottom
  });
  it("falls back to count axis when valueOf is non-finite (categorical)", () => {
    const s = axisScale("value", m, 200, { valueOf: () => NaN });
    // count axis: 2010 starts at 8/10 -> 160
    expect(s.toY(m.landmarks[1])).toBe(160);
  });
});

describe("thinLabels", () => {
  it("drops labels closer than the min gap", () => {
    const ls = [
      { value: "a", startCount: 0 },
      { value: "b", startCount: 1 },
      { value: "c", startCount: 50 },
    ];
    const toY = (l) => l.startCount; // 1px per count for the test
    const kept = thinLabels(ls, 100, 10, toY).map((l) => l.value);
    expect(kept).toEqual(["a", "c"]); // b at y=1 is within 10px of a at y=0
  });
});

describe("landmarkLabel", () => {
  it("formats by dimension type", () => {
    expect(
      landmarkLabel(
        { path: [{ dimension: "year", value: "2010" }], value: "2010" },
        { groupBy: ["year"], sort: { by: "date_taken" } }
      )
    ).toBe("2010");
    expect(
      landmarkLabel(
        {
          path: [{ dimension: "folder", value: "/a/b/Trip" }],
          value: "/a/b/Trip",
        },
        { groupBy: ["folder"], sort: { by: "date_taken" } }
      )
    ).toBe("Trip");
    expect(
      landmarkLabel(
        { path: [{ dimension: "month", value: "03" }], value: "03" },
        { groupBy: ["month"], sort: { by: "date_taken" } }
      )
    ).toBe("Mar");
  });
});
