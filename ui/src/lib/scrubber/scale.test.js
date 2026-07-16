import { describe, it, expect } from "vitest";
import {
  buildManifest,
  countToY,
  yToCount,
  landmarkAtCount,
  axisScale,
  thinLabels,
  landmarkLabel,
  densityBins,
  commonPrefixLen,
  folderLabelDepth,
  labelStopsFor,
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

  it("with a weight, keeps a dominant landmark over a tiny neighbour above it", () => {
    // "huge" sits 1px below "tiny" — greedy keeps tiny and drops huge (the 70D bug).
    const ls = [
      { value: "tiny", startCount: 0, count: 1 },
      { value: "huge", startCount: 1, count: 100 },
      { value: "far", startCount: 200, count: 5 },
    ];
    const toY = (l) => l.startCount; // 1px per count
    expect(thinLabels(ls, 300, 22, toY).map((l) => l.value)).toEqual([
      "tiny",
      "far",
    ]);
    // Priority by count keeps "huge" instead of "tiny", still in top→bottom order.
    expect(
      thinLabels(ls, 300, 22, toY, { weight: (l) => l.count }).map(
        (l) => l.value
      )
    ).toEqual(["huge", "far"]);
  });
});

describe("densityBins", () => {
  it("buckets timestamps into equal-width bins", () => {
    // width 2 over [0,10): [0,2)->{0,1}=2, [2,4)->{2}=1, [4,6)->0, [6,8)->0, [8,10)->{9}=1
    expect(densityBins([0, 1, 2, 9], 0, 10, 5)).toEqual([2, 1, 0, 0, 1]);
  });
  it("clamps out-of-range values to the edge buckets", () => {
    expect(densityBins([-5, 100], 0, 10, 2)).toEqual([1, 1]);
  });
  it("is safe for empty/degenerate input", () => {
    expect(densityBins([], 0, 10, 4)).toEqual([0, 0, 0, 0]);
    expect(densityBins([1, 2], 5, 5, 4)).toEqual([0, 0, 0, 0]); // max<=min
  });
});

describe("commonPrefixLen", () => {
  it("counts the path segments shared by every landmark", () => {
    expect(
      commonPrefixLen([
        { value: "/lib/pics/A/x" },
        { value: "/lib/pics/A/y" },
        { value: "/lib/pics/B" },
      ])
    ).toBe(2); // /lib, /pics
  });
});

describe("folderLabelDepth", () => {
  it("descends past a lopsided trunk to where the tree branches", () => {
    // Everything shares /lib/pics/trunk; the branch level is depth 3 (trunk's kids).
    const ls = [];
    for (let i = 0; i < 10; i++)
      ls.push({ value: `/lib/pics/trunk/child${i}/leaf` });
    // common prefix = /lib,/pics,/trunk = 3; depth 3 has 10 distinct children.
    expect(folderLabelDepth(ls, 8)).toBe(3);
  });
});

describe("labelStopsFor (folder tree-ancestor landmarks)", () => {
  // Depth-first tree order under a lopsided trunk (/lib/pics/trunk holds all).
  // 8 branch nodes b0..b7 each with two leaf subfolders — the two leaves of a
  // branch must collapse to ONE stop, labeled by the branch node (not the leaf,
  // and NOT one stop per leaf).
  const folderLandmarks = [];
  let start = 0;
  for (let b = 0; b < 8; b++) {
    for (const leaf of ["photos", "video"]) {
      folderLandmarks.push({
        key: `b${b}-${leaf}`,
        value: `/lib/pics/trunk/branch${b}/${leaf}`,
        startCount: start,
        count: 2,
      });
      start += 2;
    }
  }

  it("collapses each ancestor run to one stop labeled by the branch node", () => {
    const stops = labelStopsFor(folderLandmarks, "folder");
    // common prefix = /lib,/pics,/trunk (3); depth 3 has 8 distinct branches → chosen.
    // Each branch's two leaves collapse to one stop labeled by the branch folder.
    expect(stops.map((s) => s.token)).toEqual([
      "branch0",
      "branch1",
      "branch2",
      "branch3",
      "branch4",
      "branch5",
      "branch6",
      "branch7",
    ]);
    // 16 leaf landmarks → 8 stops (one per tree branch), not 16.
    expect(stops.length).toBe(8);
  });

  it("leaves shallower than the branch depth label by their own name", () => {
    const ls = [
      { key: "t", value: "/lib/pics/trunk", startCount: 0, count: 1 },
      ...folderLandmarks,
    ];
    const stops = labelStopsFor(ls, "folder");
    expect(stops[0].token).toBe("trunk"); // the trunk itself, shallower than depth 3
  });

  it("returns landmarks unchanged for non-folder dims (already coarse)", () => {
    const yearLandmarks = [
      { value: "2009", startCount: 0, count: 8 },
      { value: "2010", startCount: 8, count: 2 },
    ];
    expect(labelStopsFor(yearLandmarks, "year")).toBe(yearLandmarks);
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
