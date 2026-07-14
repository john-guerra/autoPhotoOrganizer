import { describe, it, expect } from "vitest";
import { visibleRange, runwayPx } from "./windowing.js";

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

describe("runwayPx", () => {
  it("measures the loaded content left beyond each edge of the viewport", () => {
    const boxes = buildRows(20); // rows at y = 0, 108, ... 2052; each 100 tall
    const last = boxes[boxes.length - 1];
    const contentBottom = last.y + last.height; // 2152
    const { above, below } = runwayPx(boxes, {
      scrollTop: 800,
      viewportHeight: 600,
    });
    expect(above).toBe(800); // content starts at y=0
    expect(below).toBe(contentBottom - (800 + 600));
  });

  it("is why a pixel trigger beats an entry-count one: 20 entries is not a length", () => {
    // THE BUG. The old trigger prefetched when within 20 display ENTRIES of the
    // end. With burst stacks (one entry per stack) or a big zoom, 20 entries is a
    // couple of rows — a few hundred pixels, well under a fling's per-second
    // travel — so the user outran the loader. With small thumbs it's screens.
    // Same entry count, wildly different runway; only pixels say which.
    const chunky = buildRows(10, { perRow: 1, rowHeight: 400 }); // 10 entries
    const tiny = buildRows(10, { perRow: 1, rowHeight: 40 }); // also 10 entries

    const at = (boxes) =>
      runwayPx(boxes, { scrollTop: 0, viewportHeight: 600 }).below;

    expect(at(chunky)).toBeGreaterThan(3000); // plenty of road left
    expect(at(tiny)).toBeLessThan(100); // about to hit blank space
  });

  it("never reports negative runway (scrolled past the end, or empty feed)", () => {
    const boxes = buildRows(2); // 208px of content
    expect(
      runwayPx(boxes, { scrollTop: 5000, viewportHeight: 600 }).below
    ).toBe(0);
    expect(runwayPx([], { scrollTop: 0, viewportHeight: 600 })).toEqual({
      above: 0,
      below: 0,
    });
  });

  it("accounts for content that does not start at y=0 (a prepended window)", () => {
    const boxes = buildRows(5).map((b) => ({ ...b, y: b.y + 1000 }));
    expect(
      runwayPx(boxes, { scrollTop: 1000, viewportHeight: 600 }).above
    ).toBe(0);
  });
});
