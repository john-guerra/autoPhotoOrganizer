/**
 * The ONE definition of screen<->data space for a scatter (#232).
 *
 * Hover, lasso, and draw all read it, so they cannot disagree — which is the
 * entire reason `albumTimeline.js` keeps `hitAt` out of its component. Two
 * copies of this arithmetic is a hover ring that highlights one dot while the
 * click selects its neighbour.
 *
 * A transform is `{k, tx, ty}`: screen = data * k + t. Same shape as d3-zoom's,
 * deliberately, so a d3 zoom behaviour can drive it unchanged.
 */

export const MIN_ZOOM = 0.05;
/**
 * How far in you can go.
 *
 * Generous on purpose: a dense blob on a 5,499-point map is a few hundred
 * people occupying a handful of pixels, and telling them apart means getting
 * close enough that each face fills real estate. The cap exists only to stop
 * a runaway wheel gesture producing a transform nothing can recover from.
 */
export const MAX_ZOOM = 4000;

/** @param {number} k */
export const clampZoom = (k) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(k) ? k : 1));

/**
 * @param {number} x @param {number} y
 * @param {{k:number,tx:number,ty:number}} t
 * @returns {[number, number]}
 */
export function toScreen(x, y, t) {
  return [x * t.k + t.tx, y * t.k + t.ty];
}

/**
 * @param {number} px @param {number} py
 * @param {{k:number,tx:number,ty:number}} t
 * @returns {[number, number]}
 */
export function toData(px, py, t) {
  return [(px - t.tx) / t.k, (py - t.ty) / t.k];
}

/**
 * A transform that fits every point inside `w` x `h`, with `pad` px to spare.
 *
 * @param {Float32Array|number[]} xs
 * @param {Float32Array|number[]} ys
 * @param {number} w @param {number} h @param {number} [pad]
 * @returns {{k:number,tx:number,ty:number}}
 */
export function fitExtent(xs, ys, w, h, pad = 24) {
  // A zero-sized viewport happens for one frame before layout settles, and a
  // canvas sized 0 throws. Answer with something drawable rather than NaN.
  const width = Math.max(1, w);
  const height = Math.max(1, h);
  if (!xs.length) return { k: 1, tx: width / 2, ty: height / 2 };

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const y = ys[i];
    // A non-finite point would make every bound Infinity and collapse the map.
    // The worker refuses to emit one, so this is belt-and-braces for a stale
    // cached run.
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { k: 1, tx: width / 2, ty: height / 2 };

  // A degenerate extent (every point identical, or one point) would divide by
  // zero and put k at Infinity, which paints nothing and reads as a broken
  // view rather than as a one-point map.
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const usableW = Math.max(1, width - 2 * pad);
  const usableH = Math.max(1, height - 2 * pad);
  const k = clampZoom(Math.min(usableW / spanX, usableH / spanY));

  return {
    k,
    tx: width / 2 - ((minX + maxX) / 2) * k,
    ty: height / 2 - ((minY + maxY) / 2) * k,
  };
}

/**
 * Zoom about a fixed screen point, so the thing under the cursor stays under
 * the cursor. Getting this wrong is a map that slides away as you scroll.
 *
 * @param {{k:number,tx:number,ty:number}} t
 * @param {number} factor @param {number} px @param {number} py
 */
export function zoomAbout(t, factor, px, py) {
  const k = clampZoom(t.k * factor);
  // Solve for the translation that keeps toData(px,py) invariant.
  const [dx, dy] = toData(px, py, t);
  return { k, tx: px - dx * k, ty: py - dy * k };
}
