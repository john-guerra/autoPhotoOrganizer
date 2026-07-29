/**
 * Level of detail and point size for a scatter (#232).
 *
 * ONE size rule drives both the dot and the crop. They used to be separate —
 * the dot scaled with the point's weight and the crop was a fixed function of
 * zoom — which meant that at any zoom where faces are actually drawn, every
 * person rendered identically and the encoding disappeared precisely where the
 * user was looking at it.
 */

/**
 * The default size range, in CSS px at base zoom. User-adjustable from the
 * map's gear, because the right range depends on how crowded YOUR map is.
 *
 * 1.5 is deliberately below a comfortable click target: most points weigh 1,
 * and on a 5,499-point map they must be small enough to see the structure
 * through. Hit-testing does not use the radius (see the canvas's
 * `hitRadiusData`), so a small dot is still easy to hit.
 */
export const DEFAULT_MIN_RADIUS = 1.5;
export const DEFAULT_MAX_RADIUS = 20;

/** Bounds for the user controls, so a typo cannot produce an unusable map. */
export const RADIUS_LIMITS = { min: 0.5, max: 80 };

/** Below this zoom a point is smaller than a legible face, so it stays a dot. */
export const IMAGE_ZOOM_THRESHOLD = 12;

/** How many decoded images to keep. Comfortably more than any one viewport. */
export const IMAGE_CACHE_MAX = 600;

/** The smallest crop worth drawing rather than leaving as a dot. */
export const MIN_IMAGE_SIDE = 14;

/** @param {number} k */
export const shouldDrawImages = (k) =>
  Number.isFinite(k) && k >= IMAGE_ZOOM_THRESHOLD;

/** @param {number} v @param {number} fallback */
export function clampRadius(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(RADIUS_LIMITS.max, Math.max(RADIUS_LIMITS.min, n));
}

/**
 * How much everything grows as you zoom in.
 *
 * Applied to the WHOLE size range rather than to its ceiling, so the ratio the
 * user configured is preserved at every zoom — faces get bigger without the
 * encoding flattening out. Sub-linear and bounded, or one person fills the
 * viewport.
 *
 * @param {number} k
 */
export function zoomGain(k) {
  const z = Number.isFinite(k) ? Math.max(1, k) : 1;
  return Math.min(6, 1 + Math.log10(z) * 1.1);
}

/**
 * The weight the size scale tops out at: a high quantile, not the maximum.
 *
 * Anchoring to the MAXIMUM is the obvious choice and it is wrong for this
 * data. Photo counts per person are extremely skewed — most people appear in
 * one or two photos and a single person appears in 3,512 — so a max-anchored
 * scale spends its entire range on one outlier and renders the other 5,498
 * people within a pixel of each other. Which is exactly the "they all look the
 * same size" complaint.
 *
 * A high quantile gives the bulk of the data the full radius range and lets
 * the handful above it clamp to the top.
 *
 * @param {ArrayLike<number>} weights
 * @param {number} [q]
 * @returns {number} always >= 1
 */
export function sizeAnchor(weights, q = 0.98) {
  const n = weights?.length ?? 0;
  if (!n) return { lo: 0, hi: 1 };
  const sorted = Array.from(weights, (w) => Math.max(0, Number(w) || 0)).sort(
    (a, b) => a - b
  );
  const idx = Math.min(n - 1, Math.max(0, Math.floor((n - 1) * q)));
  // BOTH ends of the domain, not just the top. Anchoring only the top means
  // uniform data (every person in two photos — a fresh library, or the e2e
  // fixture) maps every point to t = 1 and draws the whole map at MAXIMUM
  // size, which merges into one blob. With a domain of [lo, hi] and lo === hi,
  // `t` is 0 and everything draws at the minimum, which is the honest
  // rendering of "these are all the same".
  return { lo: sorted[0], hi: Math.max(sorted[0], sorted[idx]) };
}

/**
 * Point radius in CSS px, on a SQRT scale anchored to a high quantile.
 *
 * sqrt so AREA is proportional to the weight: a linear radius makes a
 * 400-photo person 100x the area of a 4-photo one and reads as two orders of
 * magnitude more than it is.
 *
 * Anchored and CLAMPED rather than free — the same thing
 * `d3.scaleSqrt().range([lo, hi]).clamp(true)` does, without pulling d3 into a
 * module that runs per point per frame.
 *
 * @param {number} weight the point's value (here: photos the person is in)
 * @param {number} k the current zoom
 * @param {number} [maxWeight] from `sizeAnchor`
 * @param {number} [minR] range floor at base zoom
 * @param {number} [maxR] range ceiling at base zoom
 */
export function dotRadius(
  weight,
  k,
  domain = { lo: 0, hi: 1 },
  minR = DEFAULT_MIN_RADIUS,
  maxR = DEFAULT_MAX_RADIUS
) {
  const w = Math.max(0, Number(weight) || 0);
  // Accept a bare number for the old call shape, so a caller that only knows
  // a maximum still gets a sane scale.
  const d = typeof domain === "number" ? { lo: 0, hi: domain } : (domain ?? {});
  const dLo = Math.max(0, Number(d.lo) || 0);
  const dHi = Math.max(dLo, Number(d.hi) || 0);

  const lo = clampRadius(minR, DEFAULT_MIN_RADIUS);
  const hi = Math.max(lo, clampRadius(maxR, DEFAULT_MAX_RADIUS));

  // A zero-width domain is not a degenerate case to guard against, it is the
  // normal state of a young library: everyone appears in the same number of
  // photos. Drawing them all at the ceiling says "these are all enormous";
  // drawing them at the floor says "there is nothing to distinguish here",
  // which is true.
  const span = dHi - dLo;
  const t =
    span > 0 ? Math.sqrt(Math.min(1, Math.max(0, (w - dLo) / span))) : 0;
  return (lo + (hi - lo) * t) * zoomGain(k);
}

/**
 * The largest radius anything can be drawn at, for culling and hit-testing.
 * @param {number} k @param {number} [maxR]
 */
export function maxRadiusAt(k, maxR = DEFAULT_MAX_RADIUS) {
  return clampRadius(maxR, DEFAULT_MAX_RADIUS) * zoomGain(k);
}

/**
 * The crop's drawn side, in CSS px.
 *
 * The diameter of the point, so a face and its dot carry the same encoding and
 * it survives at the zoom where you are reading faces. Floored so a tiny point
 * does not become an unrecognisable smudge.
 *
 * @param {number} k @param {number} [weight] @param {number} [maxWeight]
 * @param {number} [minR] @param {number} [maxR]
 */
export function imageSide(
  k,
  weight = 1,
  domain = { lo: 0, hi: 1 },
  minR = DEFAULT_MIN_RADIUS,
  maxR = DEFAULT_MAX_RADIUS
) {
  return Math.max(
    MIN_IMAGE_SIDE,
    Math.round(dotRadius(weight, k, domain, minR, maxR) * 2)
  );
}
