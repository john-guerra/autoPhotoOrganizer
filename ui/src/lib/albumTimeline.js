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

/**
 * Which album each photo belongs to, as one array parallel to `photos`.
 *
 * A merge, not a lookup per photo: both sequences are ordered, so one walk over
 * each suffices. -1 means "no album covers it", which the clustering should never
 * produce — but this does not pretend otherwise if it does.
 *
 * @param {Array<{t: number}>} photos  ascending by `t`
 * @param {Array<{startAt: number, endAt: number}>} albums  ordered, disjoint
 * @returns {Int32Array} albumIndex per photo, -1 where none
 */
export function albumOfPhotos(photos, albums) {
  const n = photos?.length ?? 0;
  const out = new Int32Array(n).fill(-1);
  const m = albums?.length ?? 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const t = photos[i].t;
    while (a < m && albums[a].endAt < t) a++;
    if (a < m && t >= albums[a].startAt) out[i] = a;
  }
  return out;
}

/** How far the cursor may sit from a photo and still be taken to mean it. */
export const SNAP_PX = 6;

/**
 * What the cursor is pointing AT: the album to act on, and the photo to preview.
 *
 * One function so that hovering and clicking can never disagree — if the timeline
 * shows you a photo, clicking must go to that photo's album.
 *
 * The exact-time answer (`albumAtTime` alone) is NOT enough, and this is the bug
 * this function exists to prevent: zoomed out to twenty years, an album spanning a
 * few hours is far narrower than one pixel. The cursor lands in the GAP between
 * two bands while sitting visually right on top of a dot, so an exact-time hit
 * test silently reports "nothing here" — and the click is dropped on precisely
 * the albums a user most needs to click. Observed live: a click on a visible,
 * 112-photo album did nothing at all.
 *
 * So: prefer the album under the cursor's instant; failing that, fall back to the
 * album of the nearest photo, but only when that photo is genuinely within
 * `snapPx`. A real gap stays empty — click far from any photo and nothing happens,
 * which is the truth — while every visible dot becomes clickable.
 *
 * Pure: `xOf` maps a time to a pixel, so the caller owns the scale and this owns
 * the decision.
 *
 * @param {object} o
 * @param {number} o.px  cursor x, in the same pixel space `xOf` returns
 * @param {number[]} o.times  photo times, ascending
 * @param {Array<{startAt:number, endAt:number}>} o.albums
 * @param {Int32Array|number[]} o.albumOfPhoto  from `albumOfPhotos`
 * @param {(t:number)=>number} o.xOf  time -> pixel
 * @param {(px:number)=>number|null} o.timeAt  pixel -> time
 * @param {number} [o.snapPx]
 * @returns {{album: number, photo: number}} indices; -1 for "nothing there"
 */
export function hitAt({
  px,
  times,
  albums,
  albumOfPhoto,
  xOf,
  timeAt,
  snapPx = SNAP_PX,
}) {
  const none = { album: -1, photo: -1 };
  const t = timeAt(px);
  if (t == null || !Number.isFinite(t)) return none;

  const pi = nearestPhoto(times, t);
  const nearPhoto = pi >= 0 && Math.abs(xOf(times[pi]) - px) <= snapPx;

  let ai = albumAtTime(albums, t);
  if (ai < 0 && nearPhoto) ai = albumOfPhoto[pi];

  return { album: ai, photo: nearPhoto ? pi : -1 };
}
