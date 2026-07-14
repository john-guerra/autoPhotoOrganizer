/**
 * Given absolute-positioned boxes sorted by ascending y (as produced by
 * justifiedLayout — rows are emitted in row order, and every box in a row
 * shares the same y), return the inclusive index range of boxes that
 * intersect the current viewport, expanded by `overscanPx` on each side.
 *
 * Pure — no DOM. Both y and y+height are non-decreasing across the array
 * (each new row starts at least the previous row's height+gap further
 * down), so both predicates below are monotonic and a binary search is
 * valid. A future non-row-based layout (e.g. an embedding scatter) would
 * need its own visibility query — this one assumes row-monotonic y.
 *
 * @param {Array<{id: number|string, x: number, y: number, width: number, height: number}>} boxes
 * @param {{ scrollTop: number, viewportHeight: number, overscanPx?: number }} opts
 * @returns {{ start: number, end: number }} inclusive index range into `boxes`;
 *   `{ start: 0, end: -1 }` means nothing is in range.
 */
export function visibleRange(
  boxes,
  { scrollTop, viewportHeight, overscanPx = 800 }
) {
  if (!boxes.length) return { start: 0, end: -1 };

  const lo = scrollTop - overscanPx;
  const hi = scrollTop + viewportHeight + overscanPx;

  const start = firstIndexWhere(boxes, (b) => b.y + b.height >= lo);
  const afterEnd = firstIndexWhere(boxes, (b) => b.y > hi);
  const end = afterEnd - 1;

  return start > end ? { start: 0, end: -1 } : { start, end };
}

/**
 * How much laid-out content is left ABOVE and BELOW the viewport, in pixels.
 *
 * This is the runway: how far the user can scroll before they run out of loaded
 * feed and hit blank space. Prefetch has to fire while the runway is still
 * longer than a round trip takes to fly — otherwise you outrun the loader, which
 * is exactly what "the album loading is slower than I can scroll" means.
 *
 * Why pixels and not a count of items: the feed used to prefetch when it got
 * within 20 display ENTRIES of an edge, which is a runway of wildly varying
 * length. 20 entries of a burst-stacked feed (each entry a whole stack), or 20
 * entries at the largest zoom, is a few hundred pixels — under half a second at
 * a fling's 3,000-6,000 px/s. 20 entries of tiny thumbnails is several screens.
 * The user scrolls in pixels, so the trigger belongs in pixels.
 *
 * Boxes are absolutely positioned and y-monotonic (see visibleRange), so the
 * content extent is just the first box's top and the last box's bottom.
 *
 * @param {Array<{y: number, height: number}>} boxes
 * @param {{ scrollTop: number, viewportHeight: number }} opts
 * @returns {{ above: number, below: number }} pixels of loaded content beyond
 *   each edge of the viewport. Never negative.
 */
export function runwayPx(boxes, { scrollTop, viewportHeight }) {
  if (!boxes.length) return { above: 0, below: 0 };
  const top = boxes[0].y;
  const last = boxes[boxes.length - 1];
  const bottom = last.y + last.height;
  return {
    above: Math.max(0, scrollTop - top),
    below: Math.max(0, bottom - (scrollTop + viewportHeight)),
  };
}

/**
 * Binary search: predicate(boxes[i]) is false for a prefix and true for the
 * rest. Returns the first true index, or boxes.length if never true.
 */
function firstIndexWhere(boxes, predicate) {
  let lo = 0;
  let hi = boxes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (predicate(boxes[mid])) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
