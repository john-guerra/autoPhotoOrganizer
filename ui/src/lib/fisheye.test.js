import { describe, it, expect } from "vitest";
import {
  doiWeight,
  deriveCheckpointDepth,
  sampleLeaves,
  layoutFisheye,
  FISHEYE_DEFAULTS,
} from "./fisheye.js";

/** Build `n` day leaves across years/months from a compact spec so tests read
 * clearly. Each entry: ["YYYY-MM-DD", count]. */
function dayLeaves(spec) {
  return spec.map(([day, count]) => {
    const [y, m] = day.split("-");
    return { values: { year: y, month: `${y}-${m}`, day }, count };
  });
}

const GB = ["year", "month", "day"];

describe("doiWeight", () => {
  it("peaks at the focus and decays smoothly and symmetrically", () => {
    const p = FISHEYE_DEFAULTS;
    expect(doiWeight(0, p)).toBe(1);
    expect(doiWeight(1, p)).toBeLessThan(1); // no flat plateau
    expect(doiWeight(2, p)).toBeLessThan(doiWeight(1, p));
    expect(doiWeight(20, p)).toBeLessThan(doiWeight(10, p));
    expect(doiWeight(-8, p)).toBeCloseTo(doiWeight(8, p)); // symmetric
    expect(doiWeight(10000, p)).toBeGreaterThan(0); // always positive
  });
});

describe("deriveCheckpointDepth", () => {
  it("marks index 0, year changes (depth 0) and month changes (depth 1); nulls day-only changes", () => {
    const leaves = dayLeaves([
      ["2024-06-13", 1], // 0 -> start (depth 0)
      ["2024-06-14", 1], // day-only change -> null
      ["2024-07-01", 1], // month change -> depth 1
      ["2025-01-02", 1], // year change -> depth 0
    ]);
    expect(deriveCheckpointDepth(leaves, GB)).toEqual([0, null, 1, 0]);
  });

  it("produces no checkpoints beyond index 0 for a single-level groupBy", () => {
    const leaves = [
      { values: { folder: "/a" }, count: 1 },
      { values: { folder: "/b" }, count: 1 },
    ];
    expect(deriveCheckpointDepth(leaves, ["folder"])).toEqual([0, null]);
  });
});

describe("sampleLeaves", () => {
  const many = dayLeaves(
    Array.from({ length: 400 }, (_, i) => {
      const day = String((i % 27) + 1).padStart(2, "0");
      const month = String((Math.floor(i / 27) % 12) + 1).padStart(2, "0");
      const year = 2000 + Math.floor(i / (27 * 12));
      return [`${year}-${month}-${day}`, 1];
    })
  );

  it("keeps everything when the list is already small", () => {
    const small = dayLeaves([
      ["2024-06-13", 3],
      ["2024-06-14", 5],
    ]);
    const cps = deriveCheckpointDepth(small, GB);
    const kept = sampleLeaves(small, cps, 0, { maxRows: 50, vicinity: 4 });
    expect(kept.map((k) => k.i)).toEqual([0, 1]);
    expect(kept.map((k) => k.binCount)).toEqual([3, 5]);
  });

  it("decimates a long list but preserves total photo mass in binCounts", () => {
    const cps = deriveCheckpointDepth(many, GB);
    const kept = sampleLeaves(many, cps, 200, { maxRows: 40, vicinity: 4 });
    expect(kept.length).toBeLessThan(many.length);
    const keptMass = kept.reduce((s, k) => s + k.binCount, 0);
    const trueMass = many.reduce((s, l) => s + l.count, 0);
    expect(keptMass).toBe(trueMass); // no photo dropped from the silhouette
  });

  it("always keeps the near zone, every checkpoint, and the endpoints", () => {
    const cps = deriveCheckpointDepth(many, GB);
    const focusI = 150;
    const kept = sampleLeaves(many, cps, focusI, { maxRows: 30, vicinity: 4 });
    const keptI = new Set(kept.map((k) => k.i));
    for (let i = focusI - 4; i <= focusI + 4; i++) expect(keptI.has(i)).toBe(true);
    cps.forEach((d, i) => {
      if (d != null) expect(keptI.has(i)).toBe(true);
    });
    expect(keptI.has(0)).toBe(true);
    expect(keptI.has(many.length - 1)).toBe(true);
  });
});

describe("layoutFisheye", () => {
  const leaves = dayLeaves(
    Array.from({ length: 120 }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, "0");
      const month = String((Math.floor(i / 28) % 12) + 1).padStart(2, "0");
      return [`2024-${month}-${day}`, (i % 7) + 1];
    })
  );

  it("returns empty for empty input or zero height", () => {
    expect(layoutFisheye([], GB, { height: 500, focusI: 0 }).rows).toEqual([]);
    expect(layoutFisheye(leaves, GB, { height: 0, focusI: 0 }).rows).toEqual([]);
  });

  it("fills the viewport exactly and keeps rows ordered with positive thickness", () => {
    const height = 600;
    const { rows } = layoutFisheye(leaves, GB, { height, focusI: 60 });
    const total = rows.reduce((s, r) => s + r.thickness, 0);
    expect(total).toBeCloseTo(height, 4);
    for (const r of rows) expect(r.thickness).toBeGreaterThan(0);
    for (let j = 1; j < rows.length; j++) {
      expect(rows[j].i).toBeGreaterThan(rows[j - 1].i); // sample stays ordered
      expect(rows[j].y).toBeGreaterThan(rows[j - 1].y); // centers monotonic
    }
  });

  it("makes the focus row the single tallest (a lens peak)", () => {
    const { rows } = layoutFisheye(leaves, GB, { height: 600, focusI: 60 });
    const focusRow = rows.find((r) => r.i === 60);
    expect(focusRow).toBeTruthy();
    for (const r of rows) {
      if (r.i !== 60) expect(r.thickness).toBeLessThanOrEqual(focusRow.thickness);
    }
  });

  it("works at both edges without error", () => {
    for (const focusI of [0, leaves.length - 1]) {
      const { rows } = layoutFisheye(leaves, GB, { height: 500, focusI });
      const total = rows.reduce((s, r) => s + r.thickness, 0);
      expect(total).toBeCloseTo(500, 4);
    }
  });
});
