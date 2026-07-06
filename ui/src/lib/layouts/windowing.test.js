import { describe, it, expect } from "vitest";
import { visibleRange } from "./windowing.js";

/** N rows of `perRow` boxes each, height `rowHeight`, stacked with `gap`. */
function buildRows(rowCount, { perRow = 2, rowHeight = 100, gap = 8 } = {}) {
  const boxes = [];
  let id = 0;
  for (let r = 0; r < rowCount; r++) {
    const y = r * (rowHeight + gap);
    for (let c = 0; c < perRow; c++) {
      boxes.push({ id: id++, x: c * 100, y, width: 100, height: rowHeight });
    }
  }
  return boxes;
}

describe("visibleRange", () => {
  it("returns an empty range for no boxes", () => {
    expect(visibleRange([], { scrollTop: 0, viewportHeight: 800 })).toEqual({
      start: 0,
      end: -1,
    });
  });

  it("includes only rows intersecting the viewport, no overscan", () => {
    // 5 rows, each 100px + 8px gap: y = 0, 108, 216, 324, 432 (2 boxes/row).
    const boxes = buildRows(5);
    const { start, end } = visibleRange(boxes, {
      scrollTop: 100,
      viewportHeight: 200,
      overscanPx: 0,
    });
    // Viewport [100, 300] overlaps rows 0 (0-100), 1 (108-208), 2 (216-316).
    expect(start).toBe(0);
    expect(end).toBe(5); // rows 0-2, 2 boxes each -> indices 0..5
  });

  it("expands the range with overscanPx", () => {
    const boxes = buildRows(5);
    const tight = visibleRange(boxes, {
      scrollTop: 216,
      viewportHeight: 100,
      overscanPx: 0,
    });
    const overscanned = visibleRange(boxes, {
      scrollTop: 216,
      viewportHeight: 100,
      overscanPx: 200,
    });
    expect(overscanned.end).toBeGreaterThan(tight.end);
    expect(overscanned.start).toBeLessThanOrEqual(tight.start);
  });

  it("returns an empty range when scrolled past all content", () => {
    const boxes = buildRows(5);
    const { start, end } = visibleRange(boxes, {
      scrollTop: 10000,
      viewportHeight: 800,
      overscanPx: 0,
    });
    expect(end).toBeLessThan(start);
  });

  it("includes the first row when the viewport approaches it from above", () => {
    const boxes = buildRows(5);
    const { start, end } = visibleRange(boxes, {
      scrollTop: -50,
      viewportHeight: 100,
      overscanPx: 0,
    });
    expect(start).toBe(0);
    expect(end).toBe(1); // row 0 only (2 boxes)
  });

  it("stays small relative to a large total row count", () => {
    const boxes = buildRows(5000); // 10,000 boxes total
    const { start, end } = visibleRange(boxes, {
      scrollTop: 50000,
      viewportHeight: 800,
    });
    expect(end - start + 1).toBeLessThan(50); // a handful of rows, not 10k
  });
});
