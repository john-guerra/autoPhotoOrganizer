/**
 * A seeded PRNG, so a projection run is reproducible (#232).
 *
 * This is not a nicety — it is what makes the run cache CORRECT. A cached map
 * is served on the promise that re-running the same parameters would produce
 * the same map; with `Math.random` that promise is false, and nothing anywhere
 * would ever report the difference. The seed is part of the cache key for the
 * same reason.
 *
 * Hand-rolled rather than a dependency: mulberry32 is four lines, and both
 * consumers need a plain `() => number in [0,1)`.
 */

/** @param {number} seed @returns {() => number} */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seeded standard-normal source, Marsaglia polar.
 *
 * `@keckelt/tsne` (Karpathy's tsnejs) draws every random number through one
 * prototype method, `gaussRandom`, which calls `Math.random`. Overriding that
 * single method on the instance is the whole of what makes t-SNE reproducible
 * here — there is no seed option.
 *
 * The polar method produces TWO normals per iteration; caching the second is
 * not an optimisation but part of matching the original's call pattern.
 *
 * @param {() => number} rand a uniform source, e.g. from `mulberry32`
 * @returns {() => number}
 */
export function gaussianFrom(rand) {
  let spare = null;
  return function () {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u, v, s;
    do {
      u = 2 * rand() - 1;
      v = 2 * rand() - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m;
    return u * m;
  };
}
