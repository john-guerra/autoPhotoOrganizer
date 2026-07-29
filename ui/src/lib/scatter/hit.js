/**
 * Spatial index for a scatter (#232).
 *
 * Pure and separate from the component for `albumTimeline.js`'s reason: hover
 * and click must ask the same question of the same structure, or they answer
 * differently and the user picks a dot they were not pointing at.
 *
 * d3-quadtree, because d3 is already a dependency and `visit` prunes by
 * rectangle for free — which is what makes the lasso proportional to what it
 * encloses rather than to the whole map.
 */
import { quadtree } from "d3";

/**
 * @param {Float32Array|number[]} xs
 * @param {Float32Array|number[]} ys
 * @returns {import("d3").Quadtree<number>} indexed by POINT INDEX, not id —
 *   the index never learns what a point means.
 */
export function buildIndex(xs, ys) {
  const idx = [];
  for (let i = 0; i < xs.length; i++) {
    // d3-quadtree already skips non-finite points on `addAll`. Filtering here
    // anyway is explicit rather than load-bearing: it keeps this module from
    // depending on an undocumented behaviour of a library, and it costs one
    // comparison per point at build time.
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) idx.push(i);
  }
  const t = quadtree()
    .x((i) => xs[i])
    .y((i) => ys[i])
    .addAll(idx);
  // Carried so `lasso.caught` can read coordinates without a second closure
  // over the same arrays, which is how the two would drift apart.
  t._xs = xs;
  t._ys = ys;
  return t;
}

/**
 * Index of the nearest point within `radius`, or -1.
 *
 * -1 rather than null or undefined, matching `hitAt`'s existing convention in
 * this repo so a caller cannot get it subtly wrong.
 *
 * @param {import("d3").Quadtree<number>} index
 * @param {number} x @param {number} y @param {number} radius
 * @returns {number}
 */
export function nearest(index, x, y, radius) {
  if (!index || !Number.isFinite(x) || !Number.isFinite(y)) return -1;
  const found = index.find(x, y, radius);
  return found === undefined ? -1 : found;
}
