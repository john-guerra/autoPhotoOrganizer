/**
 * Geometry and hit-testing for the album timeline. Pure — no DOM, no d3, no
 * Svelte — so the parts that can actually be wrong can actually be tested.
 *
 * The component around this draws things; everything here answers questions:
 * what range did we analyze, which photo is under the cursor, which album is
 * under this instant. Those are the three questions the chart has to get right,
 * and none of them needs a browser to check.
 */

/**
 * The time range actually analyzed — the domain of the whole chart.
 *
 * NOT the library's range: `AlbumsView` clusters at most `limit` photos (20,000
 * by default) out of a library that may hold far more, so this is the span of
 * what was really looked at. Drawing the library's range here, with clusters that
 * only cover part of it, would be a lie about what was clustered.
 *
 * @param {Array<{t: number}>} photos  ascending by `t` (the server orders it)
 * @returns {[number, number] | null} [minMs, maxMs], or null when there is
 *   nothing to draw. A span of zero (every photo at one instant — a real case for
 *   a folder of scanned images) returns [t, t]: the caller must handle it, and it
 *   is not this function's job to invent a range that does not exist.
 */
export function analyzedDomain(photos) {
  if (!photos?.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const p of photos) {
    const t = p?.t;
    if (!Number.isFinite(t)) continue; // a photo with no usable time is not a point in time
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return [min, max];
}

/**
 * The photo nearest a given instant — for the hover tooltip.
 *
 * A binary search, not a quadtree: `times` is already ascending, so the array we
 * were handed IS the spatial index. Building another one would be re-deriving a
 * fact the data already tells us.
 *
 * @param {number[]} times  ascending
 * @param {number} t
 * @returns {number} the index into `times` of the nearest photo, or -1 if empty
 */
export function nearestPhoto(times, t) {
  const n = times?.length ?? 0;
  if (!n || !Number.isFinite(t)) return -1;

  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  // `lo` is the first index at or after `t`; the nearest is that one or the one
  // before it — whichever is actually closer.
  const after = lo;
  const before = lo > 0 ? lo - 1 : 0;
  return Math.abs(times[after] - t) < Math.abs(t - times[before])
    ? after
    : before;
}

/**
 * Which album covers a given instant.
 *
 * Returns -1 inside a GAP — and that is the point of the chart, not an edge case
 * to paper over: the gaps between albums are the break points. An album spans
 * [startAt, endAt] inclusive, because those are real photo timestamps, not
 * half-open bin edges.
 *
 * @param {Array<{startAt: number, endAt: number}>} albums  ordered, disjoint
 * @param {number} t
 * @returns {number} the album's index, or -1 when `t` falls in a gap or outside
 */
export function albumAtTime(albums, t) {
  const n = albums?.length ?? 0;
  if (!n || !Number.isFinite(t)) return -1;

  let lo = 0;
  let hi = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const a = albums[mid];
    if (t < a.startAt) hi = mid - 1;
    else if (t > a.endAt) lo = mid + 1;
    else return mid;
  }
  return -1;
}
