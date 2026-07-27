/**
 * The pure geometry of face detection (#166): decoding SCRFD's raw heads into
 * boxes, suppressing overlaps, and solving the transform that aligns a found
 * face onto ArcFace's canonical crop.
 *
 * DOM-free, model-free, allocation-light — every function here is total and
 * testable without downloading 190 MB of weights, which is the point. The ONNX
 * sessions live in the worker; this is the arithmetic between them, and the
 * arithmetic is where a face pipeline silently goes wrong. A detector whose
 * anchor stride is off by a factor of two still returns plausible boxes in
 * plausible places; a similarity transform with a sign error still produces a
 * 112x112 crop of a face. Neither throws. Both poison every embedding
 * downstream, and you find out months later when two strangers cluster
 * together.
 *
 * ## Why 640, and why it is not a tuning knob
 *
 * `buffalo_l/detection.onnx` declares a dynamic input `[1,3,?,?]` but STATIC
 * output rows: 12800, 3200, 800. Those are 80x80, 40x40 and 20x20 grids at
 * strides 8/16/32, two anchors per cell — i.e. the graph was exported for a
 * 640x640 input. Feeding it another size does not error; it returns rows the
 * decoder below would index against the wrong grid width. `DET_SIZE` is
 * therefore a property of the weights, not a preference.
 *
 * Measured on the real library (31,981 images, darwin/arm64, 2026-07-27), 640
 * is also nearly free: resizing to 640 costs 19.9 ms/photo against 16.6 ms for
 * 320, because both are dominated by the JPEG decode of the original (16.4 ms
 * even at 160 px, against 3.9 ms to read the header alone). The issue that
 * commissioned this called input resolution "the main cost driver of the whole
 * feature"; the measurement says it is not, and inference is.
 */

/** The detector graph's native input, fixed by the export. See the module doc. */
export const DET_SIZE = 640;

/** SCRFD's three feature-map strides and anchors-per-cell, likewise baked into
 *  the export — the 12800/3200/800 output rows only decode under these. */
export const STRIDES = [8, 16, 32];
export const ANCHORS_PER_CELL = 2;

/**
 * ArcFace's canonical five-point template for a 112x112 crop: left eye, right
 * eye, nose, left mouth corner, right mouth corner. Every ArcFace recognizer
 * was trained on crops aligned to exactly these coordinates, so they are part
 * of the model contract and not a framing choice.
 */
export const ARCFACE_TEMPLATE = Object.freeze([
  Object.freeze([38.2946, 51.6963]),
  Object.freeze([73.5318, 51.5014]),
  Object.freeze([56.0252, 71.7366]),
  Object.freeze([41.5493, 92.3655]),
  Object.freeze([70.7299, 92.2041]),
]);

/**
 * Map a letterbox scale onto a source image.
 *
 * The letterbox is top-left anchored with no centring offset, matching what
 * InsightFace's own pipeline does — which matters because the inverse mapping
 * below assumes it. A centred letterbox with this decoder would shift every
 * keypoint by half the padding.
 *
 * @param {number} width source width, AFTER EXIF rotation
 * @param {number} height source height, AFTER EXIF rotation
 * @returns {{scale:number, width:number, height:number}} the scale to apply and
 *   the resulting content size inside the DET_SIZE square
 */
export function letterbox(width, height) {
  if (!(width > 0) || !(height > 0)) {
    throw new Error(
      `letterbox needs positive dimensions, got ${width}x${height}`
    );
  }
  const scale = Math.min(DET_SIZE / width, DET_SIZE / height);
  return {
    scale,
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

/**
 * Decode one stride's three heads into faces, in DET_SIZE pixel space.
 *
 * SCRFD predicts DISTANCES from each anchor centre, in stride units — not
 * corner coordinates. Forgetting the `* stride` yields boxes clustered near
 * the top-left of the image at roughly 1/8 scale, which reads as "the detector
 * is bad at this photo" rather than as an arithmetic error.
 *
 * @param {{score: ArrayLike<number>, bbox: ArrayLike<number>, kps: ArrayLike<number>}} heads
 * @param {number} stride one of STRIDES
 * @param {number} threshold minimum score to keep
 * @returns {Array<{score:number, box:[number,number,number,number], kps:Array<[number,number]>}>}
 */
export function decodeStride({ score, bbox, kps }, stride, threshold) {
  const grid = DET_SIZE / stride;
  const out = [];
  for (let i = 0; i < score.length; i++) {
    if (!(score[i] >= threshold)) continue;
    // Anchors are stacked per cell, so ANCHORS_PER_CELL consecutive rows share
    // one centre. Dividing by the wrong factor walks the grid at the wrong
    // rate and skews every box progressively across the image.
    const cell = Math.floor(i / ANCHORS_PER_CELL);
    const cx = (cell % grid) * stride;
    const cy = Math.floor(cell / grid) * stride;
    const b = i * 4;
    const k = i * 10;
    const points = [];
    for (let p = 0; p < 5; p++) {
      points.push([
        cx + kps[k + p * 2] * stride,
        cy + kps[k + p * 2 + 1] * stride,
      ]);
    }
    out.push({
      score: score[i],
      box: [
        cx - bbox[b] * stride,
        cy - bbox[b + 1] * stride,
        cx + bbox[b + 2] * stride,
        cy + bbox[b + 3] * stride,
      ],
      kps: points,
    });
  }
  return out;
}

/**
 * Greedy non-maximum suppression by IoU.
 *
 * The three strides overlap deliberately, so the same face is normally found
 * two or three times. Without this every group photo reports triple the people
 * it holds, and #167's clustering would then see a "person" who appears only
 * ever alongside themself.
 *
 * @param {Array<{score:number, box:number[]}>} faces
 * @param {number} iouThreshold
 * @returns {Array<{score:number, box:number[]}>} kept faces, highest score first
 */
export function suppressOverlaps(faces, iouThreshold) {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const keep = [];
  for (const f of sorted) {
    if (!keep.some((k) => iou(f.box, k.box) > iouThreshold)) keep.push(f);
  }
  return keep;
}

/** Intersection over union of two [x1,y1,x2,y2] boxes. Zero for disjoint or
 *  degenerate boxes rather than NaN — a zero-area box is a real decoder output
 *  when a score barely clears the threshold. */
export function iou(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (!(w > 0) || !(h > 0)) return 0;
  const inter = w * h;
  const union =
    (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Least-squares 2D SIMILARITY transform (rotation + uniform scale + translation)
 * taking `src` points onto `dst` points.
 *
 *   u = a*x - b*y + tx
 *   v = b*x + a*y + ty
 *
 * Because that form is LINEAR in (a, b, tx, ty), the normal equations solve it
 * in closed form — no SVD, no iteration, no matrix library. The usual
 * reference implementation reaches for Umeyama's SVD method, which is the
 * general N-dimensional answer; in 2D it is unnecessary machinery around the
 * same result.
 *
 * Constraining to a SIMILARITY (rather than a full affine) is what makes the
 * alignment safe with only five noisy keypoints: an affine fit has six degrees
 * of freedom against ten observations and will happily shear a face to satisfy
 * a mislocated mouth corner, producing a crop that is subtly stretched — which
 * a recognizer reads as a different person.
 *
 * @param {Array<[number,number]>} src at least two distinct points
 * @param {Array<[number,number]>} dst same length as src
 * @returns {{a:number, b:number, tx:number, ty:number}}
 */
export function similarityTransform(src, dst) {
  const n = src.length;
  if (n < 2 || dst.length !== n) {
    throw new Error(
      `similarityTransform needs >=2 matched points, got ${n}/${dst.length}`
    );
  }
  let sx = 0,
    sy = 0,
    su = 0,
    sv = 0,
    sxxyy = 0,
    sxuyv = 0,
    sxvyu = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    sx += x;
    sy += y;
    su += u;
    sv += v;
    sxxyy += x * x + y * y;
    sxuyv += x * u + y * v;
    sxvyu += x * v - y * u;
  }
  // Variance of the source points about their centroid. Zero exactly when every
  // source point coincides, which is a degenerate detection rather than a
  // solvable fit — better to say so than to return Infinity and warp a crop
  // out of the image.
  const den = sxxyy - (sx * sx + sy * sy) / n;
  if (!(Math.abs(den) > 1e-12)) {
    throw new Error("similarityTransform: source points are coincident");
  }
  const a = (sxuyv - (sx * su + sy * sv) / n) / den;
  const b = (sxvyu - (sx * sv - sy * su) / n) / den;
  return {
    a,
    b,
    tx: (su - a * sx + b * sy) / n,
    ty: (sv - b * sx - a * sy) / n,
  };
}

/**
 * Invert a similarity transform, giving the destination-to-source mapping a
 * warp needs: it iterates over OUTPUT pixels and asks where each came from.
 *
 * @param {{a:number,b:number,tx:number,ty:number}} t
 * @returns {(u:number, v:number) => [number, number]}
 */
export function inverseMap({ a, b, tx, ty }) {
  const det = a * a + b * b;
  if (!(det > 1e-20)) throw new Error("inverseMap: transform is singular");
  return (u, v) => {
    const du = u - tx;
    const dv = v - ty;
    return [(a * du + b * dv) / det, (-b * du + a * dv) / det];
  };
}

/**
 * Rescale keypoints found in DET_SIZE letterbox space back to source pixels.
 *
 * This exists as its own function because the crop is deliberately taken from
 * the FULL-RESOLUTION decode rather than from the 640 the detector saw. The
 * decode has already been paid for, so the full-res pixels are in hand at no
 * extra cost — and they matter: measured over 37 real photos, an aligned crop
 * taken from the 640 and the same crop taken from full-res agree at only
 * p10=0.474 cosine, and at p50=0.678 for faces under 80 px in the original.
 * For the worst decile those are barely the same face. Detect small, recognize
 * from the biggest pixels available.
 *
 * @param {Array<[number,number]>} kps in DET_SIZE space
 * @param {number} scale the `scale` from letterbox()
 * @returns {Array<[number,number]>} in source-image pixels
 */
export function toSourceSpace(kps, scale) {
  if (!(scale > 0))
    throw new Error(`toSourceSpace needs a positive scale, got ${scale}`);
  return kps.map(([x, y]) => [x / scale, y / scale]);
}
