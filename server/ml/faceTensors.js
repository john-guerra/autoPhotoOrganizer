/**
 * Turning pixels into the two tensors the face models want (#166).
 *
 * Separated from faceGeometry.js because these are the BUFFER operations —
 * they touch raw RGB and produce Float32Arrays — while that module is pure
 * coordinate arithmetic. Both are model-free and testable without weights,
 * which is the property that matters: every bug available here is silent.
 * Normalizing to [0,1] instead of [-1,1] does not throw, it returns confident
 * embeddings of nothing. Feeding HWC where the graph wants CHW does not throw
 * either; it produces a tensor of exactly the right length.
 *
 * ## The normalization is (x - 127.5) / 128, not /255
 *
 * Both InsightFace models were trained that way, so the input distribution is
 * centred on zero. A [0,1] input is a different distribution entirely and the
 * network has no idea; it returns 512 plausible floats regardless. This is the
 * single easiest thing to get wrong in a face pipeline and the hardest to
 * notice, because everything downstream keeps working — clusters just stop
 * corresponding to people.
 */
import {
  DET_SIZE,
  ARCFACE_TEMPLATE,
  letterbox,
  similarityTransform,
  inverseMap,
} from "./faceGeometry.js";

/** ArcFace's crop is square and fixed by the recognizer's input shape. */
export const CROP_SIZE = 112;

/** Both models' input normalization. See the module doc — this is not a knob. */
const MEAN = 127.5;
const STD = 128;

/**
 * Pack an already-letterboxed RGB buffer into the detector's NCHW tensor.
 *
 * Takes the buffer rather than doing the resize itself: sharp is asynchronous
 * and libvips-backed, and doing the scaling here would make this function
 * untestable without an image decoder. The caller resizes to
 * `letterbox(w, h)` and pads to DET_SIZE x DET_SIZE; this does the arithmetic.
 *
 * @param {Uint8Array|Buffer} rgb DET_SIZE x DET_SIZE, 3 channels, top-left padded
 * @returns {Float32Array} length 3 * DET_SIZE * DET_SIZE, CHW order
 */
export function packDetectorInput(rgb) {
  const plane = DET_SIZE * DET_SIZE;
  if (rgb.length !== plane * 3) {
    // A short buffer here would otherwise read `undefined`, coerce to NaN, and
    // hand the detector a tensor of NaNs — which returns zero faces on every
    // photo and looks exactly like "the model found nobody".
    throw new Error(
      `packDetectorInput expected ${plane * 3} bytes (${DET_SIZE}x${DET_SIZE}x3), got ${rgb.length}`
    );
  }
  const out = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    out[i] = (rgb[i * 3] - MEAN) / STD;
    out[plane + i] = (rgb[i * 3 + 1] - MEAN) / STD;
    out[2 * plane + i] = (rgb[i * 3 + 2] - MEAN) / STD;
  }
  return out;
}

/**
 * Cut ArcFace's aligned 112x112 crop out of a source image.
 *
 * Iterates over DESTINATION pixels and inverse-maps each one back into the
 * source, which is the only direction that fills the output completely — a
 * forward map leaves holes wherever the scale is upward, and a face is very
 * often being upscaled.
 *
 * Bilinear rather than nearest, because a face is usually being resampled at a
 * non-integer scale and nearest-neighbour aliasing on eyes and mouth corners
 * is exactly the detail the recognizer keys on.
 *
 * Samples are CLAMPED to the source bounds rather than zero-filled. A detected
 * box routinely extends past the frame edge (someone at the side of the shot),
 * and padding with black there would put a hard false edge inside the crop;
 * clamping repeats the edge pixel, which is what every reference
 * implementation does.
 *
 * @param {Uint8Array|Buffer} rgb source image, 3 channels, HWC
 * @param {number} width source width in pixels
 * @param {number} height source height in pixels
 * @param {Array<[number,number]>} kps five keypoints IN SOURCE PIXELS
 * @returns {Float32Array} length 3 * CROP_SIZE * CROP_SIZE, CHW order
 */
export function packAlignedCrop(rgb, width, height, kps) {
  if (rgb.length < width * height * 3) {
    throw new Error(
      `packAlignedCrop: buffer holds ${rgb.length} bytes, ${width}x${height}x3 needs ${width * height * 3}`
    );
  }
  if (kps.length !== ARCFACE_TEMPLATE.length) {
    throw new Error(
      `packAlignedCrop expects ${ARCFACE_TEMPLATE.length} keypoints, got ${kps.length}`
    );
  }
  const back = inverseMap(similarityTransform(kps, ARCFACE_TEMPLATE));
  const plane = CROP_SIZE * CROP_SIZE;
  const out = new Float32Array(plane * 3);
  const maxX = width - 1;
  const maxY = height - 1;

  for (let v = 0; v < CROP_SIZE; v++) {
    for (let u = 0; u < CROP_SIZE; u++) {
      const [x, y] = back(u, v);
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const xa = clamp(x0, 0, maxX);
      const xb = clamp(x0 + 1, 0, maxX);
      const ya = clamp(y0, 0, maxY);
      const yb = clamp(y0 + 1, 0, maxY);
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const i00 = (ya * width + xa) * 3;
      const i10 = (ya * width + xb) * 3;
      const i01 = (yb * width + xa) * 3;
      const i11 = (yb * width + xb) * 3;
      const o = v * CROP_SIZE + u;
      for (let c = 0; c < 3; c++) {
        const s =
          rgb[i00 + c] * w00 +
          rgb[i10 + c] * w10 +
          rgb[i01 + c] * w01 +
          rgb[i11 + c] * w11;
        out[c * plane + o] = (s - MEAN) / STD;
      }
    }
  }
  return out;
}

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * The resize + pad geometry the caller must apply before packDetectorInput.
 *
 * Returned as data rather than performed here so the sharp call stays in the
 * worker and this module stays decoder-free. `pad` is bottom/right ONLY — the
 * letterbox is top-left anchored, which faceGeometry's decoder assumes when it
 * maps detections back (a centred pad would shift every keypoint by half the
 * padding, silently).
 *
 * @param {number} width source width AFTER EXIF rotation
 * @param {number} height source height AFTER EXIF rotation
 */
export function detectorResizePlan(width, height) {
  const { scale, width: w, height: h } = letterbox(width, height);
  return {
    scale,
    resize: { width: w, height: h },
    pad: { top: 0, left: 0, bottom: DET_SIZE - h, right: DET_SIZE - w },
  };
}
