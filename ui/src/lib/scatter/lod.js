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

/**
 * Dot radius in CSS px, by the point's weight (face count).
 *
 * sqrt so AREA tracks the count: a person with 100 faces should look
 * meaningfully bigger than one with 4, not 25 times wider.
 * @param {number} weight @param {number} k
 */
export function dotRadius(weight, k) {
  const w = Math.max(1, Number(weight) || 1);
  const base = 1.5 + Math.sqrt(w) * 0.45;
  // Grow a little with zoom, but nowhere near linearly — dots are a
  // zoomed-out affordance and should not become blobs.
  return Math.min(14, base * (1 + Math.log10(Math.max(1, k)) * 0.25));
}
