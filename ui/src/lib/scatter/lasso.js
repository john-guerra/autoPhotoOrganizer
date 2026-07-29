/**
 * Lasso selection over a scatter (#232).
 *
 * The correctness of the whole feature lives here: a lasso that catches the
 * wrong people leads to a merge that is wrong and durable, since
 * `mergePersonsBulk` marks its work `person_source = 'manual'` precisely so
 * the next grouping pass will not revise it.
 *
 * Everything is in DATA space. Converting the screen path once, on release,
 * means a pan mid-drag cannot shift what was caught.
 */

/**
 * Ray casting.
 *
 * Deliberately NOT boundary-aware. What matters is that the answer is a
 * boolean and that it is the SAME on every call for the same inputs —
 * otherwise a point flickers in and out of the selection as the polygon is
 * redrawn, and the count disagrees with the tray.
 *
 * @param {number} x @param {number} y
 * @param {Array<[number, number]>} poly
 * @returns {boolean}
 */
export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * @param {Array<[number, number]>} poly
 * @returns {[number, number, number, number]} minX, minY, maxX, maxY
 */
export function polygonBBox(poly) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of poly) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Drop points closer than `eps` to the previous one.
 *
 * A pointermove-per-pixel path is thousands of vertices, and `pointInPolygon`
 * is O(vertices) per point — so an unsimplified lasso over a large map is
 * O(points x thousands) on release.
 *
 * @param {Array<[number, number]>} path
 * @param {number} [eps]
 */
export function simplify(path, eps = 2) {
  if (path.length < 3) return path.slice();
  const out = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(path[i][0] - last[0], path[i][1] - last[1]) >= eps) {
      out.push(path[i]);
    }
  }
  // Keep the true final vertex: dropping it leaves a visible gap between the
  // drawn path and the closed polygon that was actually tested.
  const end = path[path.length - 1];
  const last = out[out.length - 1];
  if (last[0] !== end[0] || last[1] !== end[1]) out.push(end);
  return out;
}

/**
 * How many points the last `caught` actually tested against the polygon.
 *
 * Exported so the pruning can be asserted DETERMINISTICALLY. The obvious test
 * — "a lasso over 25,000 points finishes in under a frame" — is a wall-clock
 * assertion, and this repo already knows how those end: `queryPlan.test.js`
 * says a timing test "would be flaky and would only fail on someone's slow
 * laptop". It did exactly that, passing locally and failing CI at 24ms.
 *
 * Counting comparisons measures the thing the timing was a proxy for, and it
 * gives the same answer on every machine.
 */
export const lassoStats = { tested: 0 };

/**
 * Indices inside `poly`.
 *
 * Prunes with the quadtree's rectangle visit first, so the cost is
 * proportional to what the lasso encloses rather than to the whole map.
 *
 * @param {import("d3").Quadtree<number>} index from `buildIndex`
 * @param {Array<[number, number]>} poly
 * @returns {number[]} point INDICES, ascending
 */
export function caught(index, poly) {
  // Fewer than three vertices is not a region. Returning [] rather than
  // everything matters: a stray click must not select the library.
  //
  // Defence in depth, and knowingly so: ray casting already answers false for
  // every point against a 2-vertex path (each crossing toggles an even number
  // of times), and an empty path is pruned by the bbox visit below. The
  // behaviour is covered by a test; this line is here so the intent is legible
  // rather than emergent.
  if (!index || !poly || poly.length < 3) return [];

  const [minX, minY, maxX, maxY] = polygonBBox(poly);
  const xs = index._xs;
  const ys = index._ys;
  const out = [];
  lassoStats.tested = 0;

  index.visit((node, x0, y0, x1, y1) => {
    // Prune whole quadrants that cannot intersect the lasso's bounds.
    if (x0 > maxX || x1 < minX || y0 > maxY || y1 < minY) return true;
    if (!node.length) {
      let leaf = node;
      do {
        const i = leaf.data;
        lassoStats.tested++;
        if (pointInPolygon(xs[i], ys[i], poly)) out.push(i);
      } while ((leaf = leaf.next));
    }
    return false;
  });

  out.sort((a, b) => a - b);
  return out;
}

/**
 * Apply a lasso result to an existing selection.
 *
 * Shift adds, alt subtracts, neither replaces — the d3/infovis idiom, and the
 * reason the tray can be built up from several passes over a crowded map.
 *
 * @param {Set<number>} selection
 * @param {number[]} hit
 * @param {{shift?: boolean, alt?: boolean}} [mods]
 * @returns {Set<number>} a NEW set (never mutated in place, so Svelte sees it)
 */
export function applyLasso(selection, hit, mods = {}) {
  if (mods.alt) {
    const next = new Set(selection);
    for (const i of hit) next.delete(i);
    return next;
  }
  if (mods.shift) {
    const next = new Set(selection);
    for (const i of hit) next.add(i);
    return next;
  }
  return new Set(hit);
}
