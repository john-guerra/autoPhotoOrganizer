/**
 * Turning a stored face box into a square crop rectangle (#223).
 *
 * Pure and separate from the route on purpose: every bug this can have is
 * arithmetic (a rectangle that leaves the image, a zero-width extract, a crop
 * that cuts the chin off), and arithmetic is testable in 2ms without decoding
 * a single JPEG. `sharp.extract` throws on an out-of-bounds region, so an
 * unclamped rectangle is a 500 on a face tile rather than a slightly wrong
 * picture.
 */

/**
 * How much context to keep around the detector's box, as a fraction of its
 * size.
 *
 * SCRFD's box is tight to the facial landmarks — it clips the forehead and
 * chin, which is fine for the recognizer (it aligns from landmarks anyway) and
 * unrecognizable as a thumbnail. 0.35 keeps hair and jaw, which is what makes
 * a row of crops scannable by a human.
 */
export const CROP_MARGIN = 0.35;

/**
 * A SQUARE crop around a face box, clamped to the image.
 *
 * Square because the tiles are square: letting `sharp.resize` squash a
 * non-square region into a square tile distorts the face, and cropping to the
 * tile's aspect after the fact would re-introduce the clipping the margin
 * exists to avoid.
 *
 * The square is grown around the box's CENTRE and then shifted (not shrunk) if
 * it falls off an edge — a face at the very left of a photo still gets a
 * full-size crop, just an off-centre one. Only when the image is smaller than
 * the desired square does the square shrink, and it can never exceed the
 * shorter side.
 *
 * @param {{x: number, y: number, w: number, h: number}} box in oriented-image pixels
 * @param {{width: number, height: number}} image the ORIENTED dimensions
 * @param {number} [margin]
 * @returns {{left: number, top: number, width: number, height: number}}
 *   Integers, guaranteed inside the image, with width === height and >= 1 —
 *   sharp's `extract` contract.
 */
export function squareCrop(box, image, margin = CROP_MARGIN) {
  const imgW = Math.max(1, Math.floor(image.width));
  const imgH = Math.max(1, Math.floor(image.height));

  // A degenerate stored box (zero or negative) must not become a zero-width
  // extract, which sharp rejects outright.
  const bw = Math.max(1, box.w);
  const bh = Math.max(1, box.h);
  const cx = box.x + bw / 2;
  const cy = box.y + bh / 2;

  // The square never exceeds the shorter side — otherwise no placement of it
  // fits, and the shift below could not rescue it.
  const side = Math.max(
    1,
    Math.min(Math.round(Math.max(bw, bh) * (1 + 2 * margin)), imgW, imgH)
  );

  // Centre it, then SHIFT it back inside rather than shrinking: a face at the
  // edge of the frame should still fill its tile.
  const left = clamp(Math.round(cx - side / 2), 0, imgW - side);
  const top = clamp(Math.round(cy - side / 2), 0, imgH - side);

  return { left, top, width: side, height: side };
}

function clamp(v, lo, hi) {
  // `hi < lo` cannot happen given `side <= imgW/imgH` above, but Math.min
  // ordering matters if that ever changes — keep the low bound last so the
  // result is never negative.
  return Math.max(lo, Math.min(hi, v));
}
