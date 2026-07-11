import { describe, it, expect } from "vitest";
import {
  fisheyePosition,
  deriveCheckpointDepth,
  sampleLeaves,
  layoutFisheye,
} from "./fisheye.js";

/** Build day leaves from a compact spec: ["YYYY-MM-DD", count]. */
function dayLeaves(spec) {
  return spec.map(([day, count]) => {
    const [y, m] = day.split("-");
    return { values: { year: y, month: `${y}-${m}`, day }, count };
  });
}

const GB = ["year", "month", "day"];

describe("fisheyePosition", () => {
  it("keeps the focus, maps endpoints to endpoints, and is monotonic", () => {
    const [min, max, a, d] = [0, 100, 40, 4];
    expect(fisheyePosition(a, a, min, max, d)).toBeCloseTo(a);
    expect(fisheyePosition(min, a, min, max, d)).toBeCloseTo(min);
    expect(fisheyePosition(max, a, min, max, d)).toBeCloseTo(max);
    let prev = -Infinity;
    for (let x = min; x <= max; x += 5) {
      const p = fisheyePosition(x, a, min, max, d);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it("magnifies near the focus (a small step there spans more pixels than far away)", () => {
    const [min, max, a, d] = [0, 100, 50, 4];
    const nearSpan =
      fisheyePosition(51, a, min, max, d) - fisheyePosition(49, a, min, max, d);
    const farSpan =
      fisheyePosition(11, a, min, max, d) - fisheyePosition(9, a, min, max, d);
    expect(nearSpan).toBeGreaterThan(farSpan);
  });
});

describe("deriveCheckpointDepth", () => {
  it("marks index 0, year changes (depth 0) and month changes (depth 1); nulls day-only changes", () => {
    const leaves = dayLeaves([
      ["2024-06-13", 1],
      ["2024-06-14", 1],
      ["2024-07-01", 1],
      ["2025-01-02", 1],
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
    expect(keptMass).toBe(trueMass);
  });

  it("always keeps the near zone, every checkpoint, and the endpoints", () => {
    const cps = deriveCheckpointDepth(many, GB);
    const focusI = 150;
    const kept = sampleLeaves(many, cps, focusI, { maxRows: 30, vicinity: 4 });
    const keptI = new Set(kept.map((k) => k.i));
    for (let i = focusI - 4; i <= focusI + 4; i++)
      expect(keptI.has(i)).toBe(true);
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
  const PAD = 6;

  it("returns empty for empty input or zero height", () => {
    expect(layoutFisheye([], GB, { height: 500, focusI: 0 }).rows).toEqual([]);
    expect(layoutFisheye(leaves, GB, { height: 0, focusI: 0 }).rows).toEqual(
      []
    );
  });

  it("tiles the padded column, ordered, with positive thickness", () => {
    const height = 600;
    const { rows } = layoutFisheye(leaves, GB, {
      height,
      focusI: 60,
      pad: PAD,
    });
    expect(rows[0].y - rows[0].thickness / 2).toBeCloseTo(PAD, 1); // top edge
    const last = rows[rows.length - 1];
    expect(last.y + last.thickness / 2).toBeCloseTo(height - PAD, 1); // bottom edge
    for (const r of rows) expect(r.thickness).toBeGreaterThan(0);
    for (let j = 1; j < rows.length; j++) {
      expect(rows[j].i).toBeGreaterThan(rows[j - 1].i);
      expect(rows[j].y).toBeGreaterThan(rows[j - 1].y);
    }
  });

  it("makes rows near the focus thicker than the far edges (the lens)", () => {
    const { rows } = layoutFisheye(leaves, GB, { height: 600, focusI: 60 });
    const focusRow = rows.reduce((a, b) =>
      Math.abs(b.i - 60) < Math.abs(a.i - 60) ? b : a
    );
    expect(focusRow.thickness).toBeGreaterThan(rows[0].thickness);
    expect(focusRow.thickness).toBeGreaterThan(rows[rows.length - 1].thickness);
  });

  it("pins the focus to a supplied pixel: the cursor lands inside a magnified row", () => {
    const height = 600;
    const focusPx = 300;
    const { rows, focusI } = layoutFisheye(leaves, GB, { height, focusPx });
    const hit = rows.find(
      (r) =>
        focusPx >= r.y - r.thickness / 2 && focusPx <= r.y + r.thickness / 2
    );
    expect(hit).toBeTruthy(); // some rendered row's band contains the cursor
    expect(Math.abs(hit.i - focusI)).toBeLessThanOrEqual(1);
    // the row under the cursor is one of the magnified (thick) ones
    const maxThick = Math.max(...rows.map((r) => r.thickness));
    expect(hit.thickness).toBeGreaterThan(maxThick / 2);
  });

  it("works at both edges without error", () => {
    for (const focusI of [0, leaves.length - 1]) {
      const { rows } = layoutFisheye(leaves, GB, {
        height: 500,
        focusI,
        pad: PAD,
      });
      expect(rows[0].y - rows[0].thickness / 2).toBeCloseTo(PAD, 0);
      const last = rows[rows.length - 1];
      const bottom = last.y + last.thickness / 2;
      expect(bottom).toBeGreaterThan(500 - PAD - 2);
      expect(bottom).toBeLessThanOrEqual(500 - PAD + 2);
    }
  });
});

describe("layoutFisheye positioning modes on a decimated list", () => {
  // 1000 single-dimension leaves (like real folder grouping): only index 0 is a
  // checkpoint, so the layout is dominated by the vicinity/sampling interplay —
  // the exact regime where positioning mode matters.
  const many = Array.from({ length: 1000 }, (_, i) => ({
    values: { folder: `f${String(i).padStart(4, "0")}` },
    count: 1,
  }));
  const GB1 = ["folder"];
  const height = 500;
  const focusI = 500;
  const nearest = (rows, i) =>
    rows.reduce((a, b) => (Math.abs(b.i - i) < Math.abs(a.i - i) ? b : a));

  it("rank mode (default) keeps the focused rows thick enough to label", () => {
    const { rows } = layoutFisheye(many, GB1, { height, focusI });
    // the ±vicinity rows are all present and readable, not sub-label slivers
    const focusRow = nearest(rows, focusI);
    expect(focusRow.thickness).toBeGreaterThan(12);
    const vicinity = rows.filter((r) => Math.abs(r.i - focusI) <= 4);
    expect(vicinity.length).toBeGreaterThanOrEqual(8);
    for (const r of vicinity) expect(r.thickness).toBeGreaterThan(9);
  });

  it("proportional mode crushes the dense vicinity into slivers (legacy opt-in)", () => {
    const { rows } = layoutFisheye(many, GB1, {
      height,
      focusI,
      positioning: "proportional",
    });
    // consecutive vicinity leaves share a tiny proportional span → thin band
    const focusRow = nearest(rows, focusI);
    expect(focusRow.thickness).toBeLessThan(9);
  });

  it("rank mode pins the cursor to a magnified row even when decimated", () => {
    const focusPx = 250;
    const { rows } = layoutFisheye(many, GB1, { height, focusPx });
    const hit = rows.find(
      (r) =>
        focusPx >= r.y - r.thickness / 2 && focusPx <= r.y + r.thickness / 2
    );
    expect(hit).toBeTruthy();
    const maxThick = Math.max(...rows.map((r) => r.thickness));
    expect(hit.thickness).toBeGreaterThan(maxThick / 2);
  });
});
