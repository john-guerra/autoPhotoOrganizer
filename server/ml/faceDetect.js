/**
 * One photo's bytes in, its faces out (#166).
 *
 * The sessions and the image decoder arrive as PARAMETERS rather than being
 * imported, which is the only reason this file can be tested at all: the whole
 * pipeline — letterbox, detect, decode nine heads, suppress overlaps, align,
 * recognize — is exercised against fake sessions with no weights on disk. The
 * alternative is a module that can only be checked by downloading 191 MB and
 * eyeballing crops, and every wiring bug here is silent.
 *
 * ## Why the crop comes from the full-resolution decode
 *
 * Detection runs on a 640 px letterbox; the aligned 112x112 crop is cut from
 * the ORIGINAL pixels. Measured over 37 real photos, the same face cropped
 * both ways agrees at only p10 = 0.474 cosine, and p50 = 0.678 for faces under
 * 80 px in the original — for the worst decile they are barely the same face.
 * The full-res buffer costs nothing extra because the decode has already been
 * paid for to produce the 640 in the first place.
 *
 * ## Why this runs in the worker
 *
 * It holds a full-resolution decoded bitmap (up to 134 MP in this library) and
 * runs two ONNX graphs. Both belong off the main event loop — CLAUDE.md's rule
 * that heavy fs/IO never blocks the UI thread.
 */
import {
  STRIDES,
  decodeStride,
  suppressOverlaps,
  toSourceSpace,
} from "./faceGeometry.js";
import {
  packDetectorInput,
  packAlignedCrop,
  detectorResizePlan,
} from "./faceTensors.js";

/** Below this the detector is guessing. InsightFace's own default. */
export const SCORE_THRESHOLD = 0.5;
/** Two boxes overlapping more than this are one face seen by two strides. */
export const NMS_IOU = 0.4;

/**
 * A face smaller than this in the ORIGINAL image is not worth recognizing.
 *
 * Not a performance guard — a correctness one. ArcFace takes a 112x112 crop,
 * so a 20 px face is upscaled 5.6x into it and the embedding describes the
 * upscaling more than the person. Those vectors are not merely weak, they are
 * actively harmful to #167: near-identical blurry crops cluster with EACH
 * OTHER, producing a large confident "person" made of unrelated strangers.
 * Dropping them is the honest answer, and the box is still recorded so the UI
 * can say a face was seen there.
 */
export const MIN_FACE_PX = 32;

/**
 * @param {object} args
 * @param {{run: (feeds: object) => Promise<object>, inputName: string, outputNames: string[]}} args.detector
 * @param {{run: (feeds: object) => Promise<object>, inputName: string, outputName: string}} args.recognizer
 * @param {(bytes: Uint8Array) => Promise<{width: number, height: number}>} args.probe
 *   Header-only dimensions, AFTER EXIF rotation. Separate from `decode` so a
 *   photo with no people never pays for a full-resolution decode — most of a
 *   real archive. Measured at 3.9 ms against 16-26 ms to decode.
 * @param {(bytes: Uint8Array, plan: object|null) => Promise<{data: Uint8Array, width: number, height: number}>} args.decode
 *   `plan` is the letterbox from detectorResizePlan, or null for the full
 *   original. Injected so this module never imports sharp and stays
 *   unit-testable.
 * @param {(shape: number[], data: Float32Array) => object} args.tensor
 *   Wraps a Float32Array as whatever the runtime's tensor type is.
 * @param {Uint8Array} args.bytes the original file's bytes
 * @param {number} [args.dim] expected embedding width, checked not assumed
 * @returns {Promise<{faces: Array<{box: number[], score: number, vector: Float32Array}>,
 *                    skipped: number, width: number, height: number}>}
 */
export async function detectFaces({
  detector,
  recognizer,
  probe,
  decode,
  tensor,
  bytes,
  dim = 512,
}) {
  // Header first, then the 640 letterbox. A photo with no people never pays
  // for the full-resolution decode at all — which is most of a real archive.
  const size = await probe(bytes);
  const plan = detectorResizePlan(size.width, size.height);
  const small = await decode(bytes, plan);

  const detOut = await detector.run({
    [detector.inputName]: tensor(
      [1, 3, 640, 640],
      packDetectorInput(small.data)
    ),
  });

  // The nine outputs are three heads x three strides, in the order the graph
  // declares them: all three score heads, then all three bbox, then all three
  // kps. Indexed by position rather than by name because the names are
  // numeric and differ between the two packs ("448" vs "443") while the ORDER
  // is identical — which is what lets one decoder serve both.
  if (detector.outputNames.length !== STRIDES.length * 3) {
    // Nine heads, always: three strides x (score, bbox, kps). A graph with a
    // different count is not this architecture, and indexing it positionally
    // would read a bbox head as scores — plausible boxes, wrong everywhere.
    throw new Error(
      `detector declares ${detector.outputNames.length} outputs, expected ${STRIDES.length * 3}`
    );
  }
  let found = [];
  for (let i = 0; i < STRIDES.length; i++) {
    found = found.concat(
      decodeStride(
        {
          score: detOut[detector.outputNames[i]].data,
          bbox: detOut[detector.outputNames[i + 3]].data,
          kps: detOut[detector.outputNames[i + 6]].data,
        },
        STRIDES[i],
        SCORE_THRESHOLD
      )
    );
  }
  const kept = suppressOverlaps(found, NMS_IOU);

  if (!kept.length) {
    // No people: skip the expensive decode entirely and report the honest
    // empty result, which db/faces.js records as a `done` sentinel.
    return { faces: [], skipped: 0, width: size.width, height: size.height };
  }

  const full = await decode(bytes, null);
  const faces = [];
  let skipped = 0;
  for (const f of kept) {
    const box = f.box.map((v) => v / plan.scale);
    const widthPx = box[2] - box[0];
    if (widthPx < MIN_FACE_PX) {
      // Recorded as seen, but not recognized — see MIN_FACE_PX.
      skipped++;
      continue;
    }
    const kps = toSourceSpace(f.kps, plan.scale);
    const crop = packAlignedCrop(full.data, full.width, full.height, kps);
    const recOut = await recognizer.run({
      [recognizer.inputName]: tensor([1, 3, 112, 112], crop),
    });
    const vector = recOut[recognizer.outputName].data;
    if (vector.length !== dim) {
      // A right-width-looking vector of the wrong width is the one failure
      // storage cannot detect later: faceVectors lays rows out flat by `dim`
      // and would refuse the whole model long after the sweep wrote it.
      throw new Error(
        `recognizer returned ${vector.length} values, expected ${dim}`
      );
    }
    faces.push({ box, score: f.score, vector });
  }
  return { faces, skipped, width: full.width, height: full.height };
}
