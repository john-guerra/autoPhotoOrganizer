/**
 * The adapter between the sweep and the models (#166).
 *
 * `faceSweep` wants a `detect(row)`; `faceDetect` wants sessions, a decoder
 * and a tensor constructor. This is the join, and it is the only file in the
 * face stack that touches onnxruntime and sharp — which is what keeps every
 * other one unit-testable.
 *
 * `runtime` is injected for the same reason: with a fake ort and a fake sharp
 * this file's own contract (sessions built once and reused, EXIF rotation
 * applied before anything measures the image, the letterbox padded exactly as
 * faceGeometry's decoder assumes) is checkable without 191 MB on disk.
 *
 * ## The rotation is not a detail
 *
 * `sharp(bytes).metadata()` reports the dimensions BEFORE EXIF rotation, so a
 * portrait photo shot on a phone reports them transposed. Feeding that to
 * `detectorResizePlan` produces a letterbox of the wrong aspect, every
 * detection lands somewhere else in the frame, and nothing errors. Every
 * pipeline here therefore begins with `.rotate()`, and the size handed to the
 * planner is the POST-rotation one — see `orientedSize`.
 *
 * (This is not hypothetical. A probe written the naive way during the #166
 * measurement reported the crop-source cosine at p10 = 0.263; with the
 * rotation fixed it was 0.474. The whole tail was the bug.)
 *
 * ## Why there is NO rotated intermediate buffer
 *
 * The obvious way to pay `.rotate()` once is to materialize a rotated buffer
 * and hand it to both decodes. That is what this file did, and it was wrong in
 * a way review caught and the tests could not: `sharp(bytes).rotate()
 * .toBuffer()` with no format set RE-ENCODES — a full decode and a q80 4:2:0
 * JPEG write, per photo. It made two of this pipeline's claims false at once.
 * "A photo with no people never pays for a full decode" was not true, because
 * the re-encode had already decoded it; and the full-resolution crop the
 * design argues so hard for was being cut from a lossy recompression rather
 * than from the original pixels.
 *
 * So each decode reads the ORIGINAL bytes and does its own `.rotate()`. A
 * faceless photo — most of an archive — now costs exactly one decode, and one
 * libvips can shrink-on-load because the resize is in the same pipeline. A
 * photo with faces costs two decodes and, either way, zero encodes.
 */
import { detectFaces } from "./faceDetect.js";
import { faceModelById } from "./faceModels.js";

/**
 * The size the photo will have once EXIF rotation is applied.
 *
 * sharp ≥0.34 answers this directly as `metadata().autoOrient`; the manual
 * branch is the same arithmetic for anything that doesn't, and exists because
 * getting it wrong is silent — orientations 5-8 are the quarter turns, and
 * they are the only ones that transpose the frame.
 *
 * @param {{width: number, height: number, orientation?: number,
 *          autoOrient?: {width: number, height: number}}} meta
 * @returns {{width: number, height: number}}
 */
export function orientedSize(meta) {
  if (meta?.autoOrient?.width) {
    return { width: meta.autoOrient.width, height: meta.autoOrient.height };
  }
  const turned = meta?.orientation >= 5 && meta?.orientation <= 8;
  return {
    width: turned ? meta.height : meta.width,
    height: turned ? meta.width : meta.height,
  };
}

/**
 * @param {object} args
 * @param {string} args.modelId
 * @param {(file: string) => string} args.pathFor absolute path of a graph file
 * @param {object} args.runtime
 * @param {{InferenceSession: {create: Function}, Tensor: Function}} args.runtime.ort
 * @param {Function} args.runtime.sharp
 * @param {(path: string) => Promise<Uint8Array>} args.readFile
 * @returns {{detect: (row: {path: string}) => Promise<object>, close: () => Promise<void>}}
 */
export function createFaceEngine({ modelId, pathFor, runtime, readFile }) {
  const model = faceModelById(modelId);
  const { ort, sharp } = runtime;
  /** Built once, on first use. Two graphs stay resident for the whole sweep —
   *  rebuilding them per photo would cost more than the inference. */
  let sessions = null;

  async function ensure() {
    if (sessions) return sessions;
    const build = async (file) => {
      const s = await ort.InferenceSession.create(pathFor(file), {
        executionProviders: ["cpu"],
      });
      return {
        inputName: s.inputNames[0],
        outputNames: s.outputNames,
        outputName: s.outputNames[0],
        run: (feeds) => s.run(feeds),
        _session: s,
      };
    };
    sessions = {
      detector: await build("detection.onnx"),
      recognizer: await build("recognition.onnx"),
    };
    return sessions;
  }

  return {
    async detect(row) {
      const { detector, recognizer } = await ensure();
      const bytes = await readFile(row.path);
      // Header only — no pixels are read here. See the module doc: measuring
      // an unrotated pipeline is how the crop-source finding was wrong by a
      // whole decile the first time.
      const size = orientedSize(await sharp(bytes).metadata());

      return detectFaces({
        detector,
        recognizer,
        dim: model.dim,
        bytes,
        probe: async () => size,
        decode: async (buf, plan) => {
          // `.rotate()` first, on the ORIGINAL bytes, in every pipeline.
          const pipe = sharp(buf).rotate();
          if (plan) {
            // Padded bottom-right ONLY. faceGeometry's decoder maps
            // detections back assuming a top-left anchor; a centred pad
            // shifts every keypoint by half the padding, silently.
            pipe
              .resize(plan.resize.width, plan.resize.height)
              .extend({ ...plan.pad, background: { r: 0, g: 0, b: 0 } });
          }
          const { data, info } = await pipe
            .removeAlpha()
            // Force three 8-bit channels. A grayscale or CMYK photo otherwise
            // decodes to 1 or 4, packDetectorInput throws on the length, and
            // runSweep writes that photo a PERMANENT "cannot be read"
            // sentinel for what is really our own unhandled colourspace.
            .toColourspace("srgb")
            .raw()
            .toBuffer({ resolveWithObject: true });
          if (info.channels !== 3) {
            // Better a named failure than a byte-count mismatch three modules
            // downstream, which reads as a corrupt file rather than as this.
            throw new Error(
              `decoded ${info.channels} channels, expected 3 (RGB) — unsupported colourspace`
            );
          }
          return { data, width: info.width, height: info.height };
        },
        tensor: (shape, data) => new ort.Tensor("float32", data, shape),
      });
    },

    /** Free both graphs. A sweep that has finished should not hold ~200 MB of
     *  session for the rest of the process's life. */
    async close() {
      if (!sessions) return;
      for (const s of [sessions.detector, sessions.recognizer]) {
        await s._session?.release?.().catch?.(() => {});
      }
      sessions = null;
    },
  };
}
