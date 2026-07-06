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
