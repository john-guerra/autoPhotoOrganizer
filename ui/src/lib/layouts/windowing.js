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
 * Decide which index range to actually mount, retaining the previous window when
 * a fling has overshot PAST the loaded content into the bottom scroll reserve.
 *
 * `visibleRange` returns empty (`end < start`) the moment `scrollTop` drops below
 * the last laid-out box — which is exactly what a hard fling into the reserve
 * does. If we honoured that empty range the grid would tear every mounted tile
 * down to nothing (measured live: 180 tiles → 1 for ~130ms) and then rebuild it,
 * the "it refreshes the whole page and I lose context" flash. Instead we keep the
 * last real window mounted until `loadMore` backfills content the new position
 * can render, so the redraw is incremental, never a full teardown.
 *
 * Retain ONLY when the new range is empty AND we had a real previous window AND
 * that window's indices are still valid for the current entry count. That last
 * guard is essential: a fold/filter can shrink the feed below the old window, and
 * mounting stale indices past the end would read `undefined` boxes (a crash). In
 * that case we fall through to the empty range and let the replace path recenter.
 *
 * Pure — no DOM.
 *
 * @param {{ start: number, end: number }} range   fresh visibleRange result
 * @param {{ start: number, end: number }} prev     the currently-mounted window
 * @param {{ entryCount: number }} opts             length of the current feed
 * @returns {{ start: number, end: number }} the range to mount
 */
export function retainWindow(range, prev, { entryCount }) {
  const rangeEmpty = range.end < range.start;
  const hadWindow =
    prev.end >= prev.start && prev.start >= 0 && prev.end < entryCount;
  if (rangeEmpty && hadWindow) return { start: prev.start, end: prev.end };
  return { start: range.start, end: range.end };
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
 * How many ITEMS a loadMore("after") should fetch to refill roughly `runwayPx`
 * of vertical space, given the loaded layout's own pixel density. A fixed page
 * (60 items) is a few hundred px at the smallest zoom — far less than a fling
 * consumes per fetch round-trip — so the user "reaches the end before it loads
 * more". Scaling the page to the on-screen density (items ÷ content height)
 * keeps the loader ahead at every zoom; at large thumbs the density is low and
 * the result stays near `min`. Result is clamped to [min, max] and rounded.
 *
 * @param {Array<{y: number, height: number}>} boxes  loaded layout (y-monotonic)
 * @param {{ runwayPx: number, min: number, max: number }} opts
 * @returns {number} item count to request (always ≥ min, ≤ max)
 */
export function pageForRunway(boxes, { runwayPx, min, max }) {
  if (!boxes.length) return min;
  const last = boxes[boxes.length - 1];
  const contentH = last.y + last.height - boxes[0].y;
  if (!(contentH > 0) || !(runwayPx > 0)) return min;
  const itemsPerPx = boxes.length / contentH;
  const want = Math.ceil(runwayPx * itemsPerPx);
  return Math.min(max, Math.max(min, want));
}

/**
 * Height to give the scroll container: the laid-out content plus a bottom
 * RESERVE while more content remains below. Without the reserve, the scroller is
 * exactly as tall as the loaded items, so a momentum fling slams into that floor
 * and stops — and native inertia does NOT resume when loadMore appends more a
 * moment later ("quick flings get stopped because it thinks I reached the end").
 * The reserve keeps a few screens of scrollable space below the real content, so
 * a fling scrolls INTO it (briefly blank) instead of clamping, and loadMore
 * backfills it. Bounded on purpose: an unbounded reserve (the whole remaining
 * library) would need random-access windowing to fill, and a fast fling would
 * land in a huge blank gap. The reserve is dropped once nothing remains
 * (`hasMoreAfter` false), so you cannot scroll past the true end of the library.
 *
 * @param {number} totalHeight  laid-out content height (layoutResult.totalHeight)
 * @param {{ pad?: number, hasMoreAfter?: boolean, reservePx?: number }} opts
 * @returns {number} height for the scroll container (0 for no content)
 */
export function scrollableHeight(
  totalHeight,
  { pad = 0, hasMoreAfter = false, reservePx = 0 } = {}
) {
  if (!(totalHeight > 0)) return 0;
  return totalHeight + 2 * pad + (hasMoreAfter ? Math.max(0, reservePx) : 0);
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
