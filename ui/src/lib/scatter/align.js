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

/** How long a parameter change takes to play out, in ms. */
export const TWEEN_MS = 450;
