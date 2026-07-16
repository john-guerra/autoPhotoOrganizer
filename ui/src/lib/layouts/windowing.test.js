import { describe, it, expect } from "vitest";
import {
  visibleRange,
  retainWindow,
  runwayPx,
  topAnchorIndex,
  anchorScrollTop,
  aheadRange,
  pageForRunway,
  scrollableHeight,
} from "./windowing.js";

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

describe("retainWindow", () => {
  const prev = { start: 40, end: 60 };

  it("keeps the previous window when a fling overshoots past content (empty range)", () => {
    // THE fix: visibleRange goes empty the moment scrollTop drops below the last
    // box (a fling into the bottom reserve). Retaining prev keeps the grid from
    // tearing every tile down to `selected` alone.
    const empty = { start: 0, end: -1 };
    expect(retainWindow(empty, prev, { entryCount: 200 })).toEqual(prev);
  });

  it("uses the fresh range whenever it is non-empty (normal scrolling)", () => {
    const range = { start: 100, end: 130 };
    expect(retainWindow(range, prev, { entryCount: 200 })).toEqual(range);
  });

  it("does NOT retain a stale window that a shrink left past the feed end", () => {
    // A fold/filter can shorten the feed below the old window; mounting those
    // indices would read undefined boxes (a crash). Fall through to empty and
    // let the replace path recenter.
    const empty = { start: 0, end: -1 };
    expect(retainWindow(empty, prev, { entryCount: 50 })).toEqual(empty);
  });

  it("does NOT retain when there was no previous window (first empty render)", () => {
    const empty = { start: 0, end: -1 };
    const noPrev = { start: 0, end: -1 };
    expect(retainWindow(empty, noPrev, { entryCount: 200 })).toEqual(empty);
  });
});

describe("scrollableHeight", () => {
  it("is content + padding when nothing remains below (no false floor to hide)", () => {
    expect(
      scrollableHeight(10000, { pad: 8, hasMoreAfter: false, reservePx: 3000 })
    ).toBe(10016);
  });

  it("adds the reserve while more content remains, so a fling can't clamp", () => {
    // THE fix: with more to load, the scroller must be taller than the loaded
    // content or a momentum fling stops at the loaded floor.
    expect(
      scrollableHeight(10000, { pad: 8, hasMoreAfter: true, reservePx: 3000 })
    ).toBe(13016);
  });

  it("adds nothing when the reserve is zero or negative", () => {
    expect(scrollableHeight(10000, { hasMoreAfter: true, reservePx: 0 })).toBe(
      10000
    );
    expect(
      scrollableHeight(10000, { hasMoreAfter: true, reservePx: -500 })
    ).toBe(10000);
  });

  it("returns 0 for no content (nothing laid out yet)", () => {
    expect(scrollableHeight(0, { hasMoreAfter: true, reservePx: 3000 })).toBe(
      0
    );
  });
});

describe("pageForRunway", () => {
  it("falls back to min for no boxes / no runway / zero content", () => {
    const opts = { runwayPx: 2000, min: 60, max: 600 };
    expect(pageForRunway([], opts)).toBe(60);
    expect(
      pageForRunway(buildRows(4), { runwayPx: 0, min: 60, max: 600 })
    ).toBe(60);
  });

  it("scales the page UP at small (dense) thumbnails — the reach-the-end fix", () => {
    // 200 rows of 18 tiny 30px tiles = 3600 items over ~7600px → ~0.47 items/px.
    // Refilling 2×1200px of runway wants ~1137 items → clamped to max.
    const small = buildRows(200, { perRow: 18, rowHeight: 30, gap: 8 });
    expect(pageForRunway(small, { runwayPx: 2400, min: 60, max: 600 })).toBe(
      600
    );
    // ...and comfortably more than the old fixed page even before the clamp.
    expect(
      pageForRunway(small, { runwayPx: 2400, min: 60, max: 100000 })
    ).toBeGreaterThan(600);
  });

  it("stays near min at large (sparse) thumbnails", () => {
    // 20 rows of 2 large 400px tiles = 40 items over ~8160px → ~0.005 items/px.
    // Refilling 2400px wants only ~12 items → floored to min.
    const large = buildRows(20, { perRow: 2, rowHeight: 400, gap: 8 });
    expect(pageForRunway(large, { runwayPx: 2400, min: 60, max: 600 })).toBe(
      60
    );
  });

  it("never exceeds max", () => {
    const dense = buildRows(500, { perRow: 30, rowHeight: 20, gap: 4 });
    expect(
      pageForRunway(dense, { runwayPx: 5000, min: 60, max: 480 })
    ).toBeLessThanOrEqual(480);
  });
});

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

describe("topAnchorIndex", () => {
  it("returns -1 for no boxes", () => {
    expect(topAnchorIndex([], { scrollTop: 0 })).toBe(-1);
  });

  it("picks the first box still on screen at the viewport top", () => {
    // 5 rows, 2 boxes each: y = 0, 108, 216, 324, 432; each 100 tall.
    const boxes = buildRows(5);
    // scrollTop 150: row 0 (0-100) is fully above; row 1 (108-208) straddles
    // the top, so its first box (index 2) is the anchor.
    expect(topAnchorIndex(boxes, { scrollTop: 150 })).toBe(2);
  });

  it("returns index 0 when scrolled to the very top", () => {
    expect(topAnchorIndex(buildRows(5), { scrollTop: 0 })).toBe(0);
  });

  it("returns -1 when scrolled past all content", () => {
    expect(topAnchorIndex(buildRows(5), { scrollTop: 10000 })).toBe(-1);
  });
});

describe("anchorScrollTop", () => {
  it("shifts scroll by the anchor's vertical delta so it stays put", () => {
    // Content above the anchor grew by 40px (300 -> 340): scroll down 40 to
    // keep the anchor tile at the same screen position.
    expect(anchorScrollTop(500, 300, 340)).toBe(540);
  });

  it("is a no-op when the anchor did not move", () => {
    expect(anchorScrollTop(500, 300, 300)).toBe(500);
  });

  it("scrolls up when content above the anchor shrank", () => {
    expect(anchorScrollTop(500, 300, 260)).toBe(460);
  });
});

describe("aheadRange", () => {
  const opts = (o) => ({ viewportHeight: 200, direction: "down", ...o });

  it("is empty for no boxes", () => {
    expect(aheadRange([], opts({ scrollTop: 0, aheadPx: 500 }))).toEqual({
      start: 0,
      end: -1,
    });
  });

  it("is empty when the budget is zero or negative", () => {
    const boxes = buildRows(6);
    expect(aheadRange(boxes, opts({ scrollTop: 0, aheadPx: 0 })).end).toBe(-1);
    expect(aheadRange(boxes, opts({ scrollTop: 0, aheadPx: -50 })).end).toBe(
      -1
    );
  });

  it("is empty for an unknown direction", () => {
    const boxes = buildRows(6);
    expect(
      aheadRange(boxes, {
        scrollTop: 0,
        viewportHeight: 200,
        aheadPx: 500,
        direction: "sideways",
      }).end
    ).toBe(-1);
  });

  it("takes rows just below the viewport bottom when scrolling down", () => {
    // rows at y = 0,108,216,324,432,540 (2 boxes each), height 100.
    const boxes = buildRows(6);
    // viewport [0, 208] (edge 208); budget 120 -> band tops in [208, 328]:
    // row 2 (y=216) and row 3 (y=324). Indices 4..7.
    const { start, end } = aheadRange(
      boxes,
      opts({ scrollTop: 0, viewportHeight: 208, aheadPx: 120 })
    );
    expect(start).toBe(4);
    expect(end).toBe(7);
  });

  it("takes rows just above the viewport top when scrolling up", () => {
    // viewport top at 500; budget 120 -> band bottoms in [380, 500]:
    // row 3 (bottom 424) only. Indices 6..7.
    const boxes = buildRows(6);
    const { start, end } = aheadRange(boxes, {
      scrollTop: 500,
      viewportHeight: 200,
      aheadPx: 120,
      direction: "up",
    });
    expect(start).toBe(6);
    expect(end).toBe(7);
  });

  it("clamps to the last row when the budget exceeds remaining content", () => {
    const boxes = buildRows(6); // 12 boxes
    const { start, end } = aheadRange(
      boxes,
      opts({ scrollTop: 0, viewportHeight: 100, aheadPx: 100000 })
    );
    expect(start).toBe(2); // first row below the fold
    expect(end).toBe(11); // last box, not past the array
  });
});
