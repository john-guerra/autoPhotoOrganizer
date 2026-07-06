import { describe, it, expect } from "vitest";
import { justifiedLayout, layoutHeight } from "./justified.js";

const opts = { targetRowHeight: 200, containerWidth: 1000, gap: 10 };

/** Group boxes into rows by y coordinate. */
function rows(boxes) {
  const byY = new Map();
  for (const b of boxes) {
    if (!byY.has(b.y)) byY.set(b.y, []);
    byY.get(b.y).push(b);
  }
  return [...byY.values()];
}

describe("justifiedLayout", () => {
  it("fills the container width exactly on every full row", () => {
    // Nine 3:2 landscapes: 300px each at target height -> rows of 3+ flush.
    const items = Array.from({ length: 9 }, (_, id) => ({
      id,
      aspectRatio: 1.5,
    }));
    const boxes = justifiedLayout(items, opts);
    const allRows = rows(boxes);
    for (const row of allRows.slice(0, -1)) {
      const width =
        row.reduce((s, b) => s + b.width, 0) + opts.gap * (row.length - 1);
      expect(width).toBeCloseTo(opts.containerWidth, 6);
    }
  });

  it("gives every box in a row the same height, and preserves aspect ratios", () => {
    const items = [
      { id: 0, aspectRatio: 1.78 }, // 16:9 landscape
      { id: 1, aspectRatio: 0.56 }, // 9:16 portrait
      { id: 2, aspectRatio: 1.5 },
      { id: 3, aspectRatio: 1.0 },
      { id: 4, aspectRatio: 1.33 },
    ];
    const boxes = justifiedLayout(items, opts);
    for (const row of rows(boxes)) {
      const h = row[0].height;
      for (const b of row) {
        expect(b.height).toBeCloseTo(h, 6);
        const original = items.find((it) => it.id === b.id);
        expect(b.width / b.height).toBeCloseTo(original.aspectRatio, 6);
      }
    }
  });

  it("renders a portrait narrower than a landscape in the same row", () => {
    const items = [
      { id: "portrait", aspectRatio: 0.75 },
      { id: "landscape", aspectRatio: 1.78 },
      { id: 2, aspectRatio: 1.5 },
      { id: 3, aspectRatio: 1.5 },
    ];
    const boxes = justifiedLayout(items, opts);
    const portrait = boxes.find((b) => b.id === "portrait");
    const landscape = boxes.find((b) => b.id === "landscape");
    expect(portrait.y).toBe(landscape.y); // same row
    expect(portrait.width).toBeLessThan(landscape.width);
    expect(portrait.height).toBeCloseTo(landscape.height, 6);
  });

  it("leaves the last partial row at target height, not stretched", () => {
    // One photo alone: must NOT balloon to fill 1000px.
    const boxes = justifiedLayout([{ id: 0, aspectRatio: 1.5 }], opts);
    expect(boxes[0].height).toBe(opts.targetRowHeight);
    expect(boxes[0].width).toBeCloseTo(300, 6);
  });

  it("shrinks a single photo wider than the container to fit", () => {
    const pano = [{ id: 0, aspectRatio: 10 }]; // 2000px at target height
    const boxes = justifiedLayout(pano, opts);
    expect(boxes[0].width).toBeCloseTo(opts.containerWidth, 6);
    expect(boxes[0].height).toBeLessThan(opts.targetRowHeight);
  });

  it("stacks rows with the configured gap and reports total height", () => {
    const items = Array.from({ length: 6 }, (_, id) => ({
      id,
      aspectRatio: 2.5, // two 500px photos per row at target height
    }));
    const boxes = justifiedLayout(items, opts);
    const ys = [...new Set(boxes.map((b) => b.y))].sort((a, b) => a - b);
    expect(ys.length).toBeGreaterThan(1);
    for (let i = 1; i < ys.length; i++) {
      const prevRow = boxes.find((b) => b.y === ys[i - 1]);
      expect(ys[i]).toBeCloseTo(ys[i - 1] + prevRow.height + opts.gap, 6);
    }
    const last = boxes[boxes.length - 1];
    expect(layoutHeight(boxes)).toBeCloseTo(last.y + last.height, 6);
  });

  it("treats missing/invalid aspect ratios as a sane placeholder", () => {
    const boxes = justifiedLayout(
      [
        { id: 0, aspectRatio: NaN },
        { id: 1, aspectRatio: 0 },
      ],
      opts
    );
    for (const b of boxes) expect(b.width / b.height).toBeCloseTo(1.5, 6);
  });
});
