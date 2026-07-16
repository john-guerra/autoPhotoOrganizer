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
 * Index of the top-most box intersecting the viewport top — the tile to hold
 * fixed across a layout recompute so the user's eye-point does not jump. It is
 * the first box whose BOTTOM edge is still below `scrollTop` (i.e. on screen).
 * Boxes are y-monotonic (see visibleRange), so this is a binary search.
 *
 * @param {Array<{y: number, height: number}>} boxes
 * @param {{ scrollTop: number }} opts
 * @returns {number} index into `boxes`, or -1 if nothing sits at/below the top.
 */
export function topAnchorIndex(boxes, { scrollTop }) {
  if (!boxes.length) return -1;
  const i = firstIndexWhere(boxes, (b) => b.y + b.height > scrollTop);
  return i < boxes.length ? i : -1;
}

/**
 * The scrollTop that keeps an anchor box at the same on-screen position after a
 * layout recompute shifted it from `oldY` to `newY`. Scroll offset and box y
 * share one coordinate system (grid-local px, 1:1), so the correction is just
 * the box's vertical delta — no viewport/rect math needed. This is what makes a
 * metadata/resize/zoom reflow invisible: content above the anchor grew or shrank,
 * and we move the scroll by exactly that so the anchor tile does not budge.
 *
 * @param {number} currentScrollTop
 * @param {number} oldY  anchor box y BEFORE the recompute
 * @param {number} newY  anchor box y AFTER the recompute
 * @returns {number} the scrollTop to apply
 */
export function anchorScrollTop(currentScrollTop, oldY, newY) {
  return currentScrollTop + (newY - oldY);
}

/**
 * Inclusive index range of boxes JUST BEYOND the viewport in the travel
 * direction, within an `aheadPx` budget — the tiles to warm predictively so a
 * fast scroll doesn't outrun the loader. "down" takes boxes whose top sits below
 * the viewport's bottom edge (not yet visible); "up" takes boxes whose bottom
 * sits above the viewport's top edge. Boxes are y-monotonic (see visibleRange),
 * so both bounds are binary searches. Returns `{ start: 0, end: -1 }` (empty)
 * for no boxes, a non-positive budget, or an unknown direction.
 *
 * @param {Array<{y: number, height: number}>} boxes
 * @param {{ scrollTop: number, viewportHeight: number, aheadPx: number, direction: "up"|"down" }} opts
 * @returns {{ start: number, end: number }} inclusive index range into `boxes`
 */
export function aheadRange(
  boxes,
  { scrollTop, viewportHeight, aheadPx, direction }
) {
  if (!boxes.length || !(aheadPx > 0)) return { start: 0, end: -1 };

  let start, afterEnd;
  if (direction === "down") {
    const edge = scrollTop + viewportHeight;
    start = firstIndexWhere(boxes, (b) => b.y >= edge);
    afterEnd = firstIndexWhere(boxes, (b) => b.y > edge + aheadPx);
  } else if (direction === "up") {
    const edge = scrollTop;
    start = firstIndexWhere(boxes, (b) => b.y + b.height >= edge - aheadPx);
    afterEnd = firstIndexWhere(boxes, (b) => b.y + b.height > edge);
  } else {
    return { start: 0, end: -1 };
  }
  const end = afterEnd - 1;
  return start > end ? { start: 0, end: -1 } : { start, end };
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
