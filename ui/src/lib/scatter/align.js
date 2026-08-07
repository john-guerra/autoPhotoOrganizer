/**
 * Making one layout comparable to the one before it (#327).
 *
 * UMAP's output has an ARBITRARY rotation, reflection, scale and origin — none
 * of them carry information. So when a parameter changes, most of the apparent
 * movement between the old map and the new one is meaningless: the whole thing
 * has been spun and rescaled, and every point flies across the screen for no
 * reason a user could name.
 *
 * `alignTo` removes exactly that part. It finds the best similarity transform
 * (rotate, optionally reflect, scale, translate) of the new layout onto the old
 * one and applies it, so what is left to animate is only what actually changed.
 *
 * WHAT THIS DOES NOT FIX, stated plainly because it was measured: consecutive
 * layouts are still substantially different AFTER alignment — Procrustes
 * residual 0.664 at one slider notch on the real library, where 1.41 is "no
 * relationship at all", and it is not even monotonic in the parameter. So the
 * animation shows real movement rather than a spin, but a big parameter jump
 * will still rearrange the map a lot. That is the truth about UMAP, not a bug
 * in the tween — and it is why warm start was rejected (see the design doc):
 * the alternative buys smoothness by not applying the change at all.
 */

/**
 * Centre a coordinate list and report the centroid and RMS radius.
 * @param {ArrayLike<number>} xy interleaved x,y
 * @param {number} n
 */
function moments(xy, n) {
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += xy[i * 2];
    cy += xy[i * 2 + 1];
  }
  cx /= n || 1;
  cy /= n || 1;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const dx = xy[i * 2] - cx;
    const dy = xy[i * 2 + 1] - cy;
    s += dx * dx + dy * dy;
  }
  return { cx, cy, scale: Math.sqrt(s / (n || 1)) || 1 };
}

/**
 * Transform `next` so it sits as close to `prev` as a similarity transform can.
 *
 * Both arrays must describe the SAME points in the same order — the caller
 * pairs them by person id before calling.
 *
 * @param {ArrayLike<number>} prev interleaved x,y, length `2n`
 * @param {ArrayLike<number>} next interleaved x,y, length `2n`
 * @returns {Float32Array} `next`, aligned. A copy; the input is untouched.
 */
export function alignTo(prev, next) {
  const n = Math.min(prev.length, next.length) >> 1;
  const out = Float32Array.from(next);
  if (n < 2) return out;

  const P = moments(prev, n);
  const Q = moments(next, n);

  // Optimal rotation from the 2x2 cross-covariance, closed form, computed for
  // both handednesses — a reflection is as meaningless as a rotation here, and
  // refusing to consider one leaves half the maps needlessly mirrored.
  let best = null;
  for (const flip of [1, -1]) {
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      const px = (prev[i * 2] - P.cx) / P.scale;
      const py = (prev[i * 2 + 1] - P.cy) / P.scale;
      const qx = ((next[i * 2] - Q.cx) / Q.scale) * flip;
      const qy = (next[i * 2 + 1] - Q.cy) / Q.scale;
      sxx += px * qx + py * qy;
      sxy += py * qx - px * qy;
    }
    const theta = Math.atan2(sxy, sxx);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const px = (prev[i * 2] - P.cx) / P.scale;
      const py = (prev[i * 2 + 1] - P.cy) / P.scale;
      const qx = ((next[i * 2] - Q.cx) / Q.scale) * flip;
      const qy = (next[i * 2 + 1] - Q.cy) / Q.scale;
      const rx = qx * cos - qy * sin;
      const ry = qx * sin + qy * cos;
      sse += (px - rx) ** 2 + (py - ry) ** 2;
    }
    if (!best || sse < best.sse) best = { sse, flip, cos, sin };
  }

  // Map the normalised, rotated points back into the PREVIOUS layout's frame,
  // so the result is directly comparable to what is already on screen.
  for (let i = 0; i < n; i++) {
    const qx = ((next[i * 2] - Q.cx) / Q.scale) * best.flip;
    const qy = (next[i * 2 + 1] - Q.cy) / Q.scale;
    out[i * 2] = (qx * best.cos - qy * best.sin) * P.scale + P.cx;
    out[i * 2 + 1] = (qx * best.sin + qy * best.cos) * P.scale + P.cy;
  }
  return out;
}

/**
 * Ease-in-out, so the map settles rather than stopping dead.
 * @param {number} t 0..1
 */
export const easeInOut = (t) =>
  t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

/** How long ONE point takes to travel, in ms. */
export const TWEEN_MS = 450;

/**
 * How far apart the points start moving, in ms.
 *
 * d3's `.delay((d, i) => …)`, and the reason it is worth having: when several
 * hundred dots set off at the same instant the eye sees one mass sliding and
 * cannot follow any individual. Staggered, the movement reads as many separate
 * things going many separate places, which is what actually happened.
 */
export const STAGGER_MS = 260;

/** The whole animation, start to finish. */
export const TOTAL_MS = TWEEN_MS + STAGGER_MS;

/**
 * When point `i` starts moving, as a fraction of `STAGGER_MS`.
 *
 * A HASH of the index rather than the index itself. Delaying by index makes a
 * wave sweep across the map in whatever arbitrary order `persons.id` happens
 * to be, which looks mechanical and implies an ordering that does not exist.
 * Hashing scatters the starts while staying deterministic, so the same change
 * always animates the same way.
 *
 * @param {number} i @param {number} n
 * @returns {number} 0..1
 */
export function delayFraction(i, n) {
  if (!Number.isFinite(i) || !Number.isFinite(n) || n <= 1) return 0;
  // xorshift-ish integer hash; cheap and well spread for small i.
  let h = (i + 1) * 2654435761;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * How far through its own travel point `i` is.
 *
 * @param {number} elapsed ms since the animation began
 * @param {number} delay ms this point waits before setting off
 * @returns {number} 0..1, eased
 */
export function progressAt(elapsed, delay) {
  const t = (elapsed - delay) / TWEEN_MS;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return easeInOut(t);
}

/**
 * Interpolate a viewport transform.
 *
 * The camera moves BEFORE the points do, so the user is looking at the right
 * place by the time anything sets off. Zoom is interpolated in log space: `k`
 * is a multiplier, so a linear walk from 1 to 8 spends most of its time nearly
 * zoomed out and then lurches.
 *
 * @param {{k:number,tx:number,ty:number}} a
 * @param {{k:number,tx:number,ty:number}} b
 * @param {number} t 0..1
 */
export function lerpTransform(a, b, t) {
  const e = easeInOut(Math.min(1, Math.max(0, t)));
  return {
    k: Math.exp(Math.log(a.k) + (Math.log(b.k) - Math.log(a.k)) * e),
    tx: a.tx + (b.tx - a.tx) * e,
    ty: a.ty + (b.ty - a.ty) * e,
  };
}

/** How long the camera takes to re-frame before the points move. */
export const FIT_MS = 320;
