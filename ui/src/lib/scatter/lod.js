/**
 * Level of detail: when a point becomes a picture (#232).
 *
 * ONE rule, consulted by both the draw loop and the image loader. Two rules
 * drift, and the symptom is either blank tiles (loading below the draw
 * threshold) or a request storm (loading far above it).
 *
 * The reason a map of 25,758 points does not need 25,758 images: an image is
 * only drawn once a point occupies enough screen space to be recognisable, and
 * at that zoom only a few hundred points are on screen at all.
 */

/** Below this zoom a point is smaller than a legible face, so it stays a dot. */
export const IMAGE_ZOOM_THRESHOLD = 12;

/** How many decoded images to keep. Comfortably more than any one viewport. */
export const IMAGE_CACHE_MAX = 600;

/** @param {number} k */
export const shouldDrawImages = (k) =>
  Number.isFinite(k) && k >= IMAGE_ZOOM_THRESHOLD;

/**
 * Drawn side in CSS px. Capped so a deep zoom does not paint 900px faces, and
 * floored so a request is never made for something unreadable.
 * @param {number} k
 */
export function imageSide(k) {
  if (!Number.isFinite(k)) return 16;
  return Math.max(16, Math.min(96, Math.round(k * 1.6)));
}

/** The smallest dot that is still clickable, and the largest that is still a
 *  dot rather than a blob covering its neighbours. */
export const MIN_RADIUS = 2;
export const MAX_RADIUS = 26;

/**
 * Dot radius in CSS px, on a SQRT scale over the point's weight.
 *
 * sqrt so AREA is proportional to the weight, which is the only encoding a
 * reader interprets correctly: a linear radius makes a 400-weight point 100x
 * the area of a 4-weight one and reads as two orders of magnitude more.
 *
 * The scale is anchored at both ends rather than free: `MIN_RADIUS` keeps the
 * long tail clickable (most points weigh 1), and `MAX_RADIUS` stops the
 * handful of enormous ones — this library has a person in 3,512 faces — from
 * swallowing the neighbours you are trying to lasso.
 *
 * @param {number} weight @param {number} k the current zoom
 */
export function dotRadius(weight, k) {
  const w = Math.max(1, Number(weight) || 1);
  const base = MIN_RADIUS + Math.sqrt(w) * 0.9;
  // A mild response to zoom, so dots stay visible when zoomed out without
  // becoming blobs when zoomed in. Deliberately sub-linear.
  const zoomed = base * (1 + Math.log10(Math.max(1, k)) * 0.2);
  return Math.min(MAX_RADIUS, zoomed);
}
