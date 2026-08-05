/**
 * The URL for one face's crop.
 *
 * Trivial, and it exists for the `v=` on the end.
 *
 * ## Why a cache epoch (#302)
 *
 * The crop endpoint used to answer with
 * `Cache-Control: public, max-age=31536000, immutable`, which is a promise
 * that the bytes at this URL will never change. The promise was false:
 * `photo_faces.id` is a rowid, so emptying the table restarts it at 1 and ids
 * are reused — after a reset and rescan, `/api/ml/faces/7/crop` is a different
 * person's face.
 *
 * Fixing the SERVER is not enough, and this is the part that bites. A response
 * already in the browser's disk cache is served **without contacting the
 * server at all** until its own `max-age` expires, and `immutable` tells the
 * browser not to revalidate even on a reload. So every wrong crop already
 * cached stays wrong for a year, no matter what the server now says. John was
 * still seeing stale faces on a build that had the server fix in it.
 *
 * Changing the URL is the only thing that escapes an entry that is already
 * cached. Bump this number if it ever happens again — it costs one re-fetch of
 * some small JPEGs and nothing else.
 *
 * Going forward the endpoint sends an ETag with `Cache-Control: no-cache`, so
 * the browser revalidates and this epoch should never need to move again.
 */
export const CROP_CACHE_EPOCH = 2;

/**
 * @param {number|null|undefined} faceId
 * @param {number} [size]
 * @returns {string|null} null when there is no cover face, so a caller can
 *   render initials rather than a broken image.
 */
export function faceCropUrl(faceId, size = 160) {
  if (!faceId) return null;
  return `/api/ml/faces/${faceId}/crop?size=${size}&v=${CROP_CACHE_EPOCH}`;
}
