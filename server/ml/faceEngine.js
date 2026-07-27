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
 * detection lands somewhere else in the frame, and nothing errors. The whole
 * pipeline therefore works on an already-rotated buffer, produced once here
 * and reused for both the letterbox and the full-resolution crop — which also
 * means the expensive `.rotate()` is paid once rather than twice.
 *
 * (This is not hypothetical. A probe written the naive way during the #166
 * measurement reported the crop-source cosine at p10 = 0.263; with the
 * rotation fixed it was 0.474. The whole tail was the bug.)
 */
import { detectFaces } from "./faceDetect.js";
import { faceModelById } from "./faceModels.js";
import { DET_SIZE } from "./faceGeometry.js";

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
      // ONE rotate for the whole photo. See the module doc — measuring an
      // unrotated pipeline is how the crop-source finding was wrong by a
      // whole decile the first time.
      const rotated = await sharp(bytes).rotate().toBuffer();
      const meta = await sharp(rotated).metadata();

      return detectFaces({
        detector,
        recognizer,
        dim: model.dim,
        bytes: rotated,
        probe: async () => ({ width: meta.width, height: meta.height }),
        decode: async (buf, plan) => {
          if (!plan) {
            const { data, info } = await sharp(buf)
              .removeAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });
            return { data, width: info.width, height: info.height };
          }
          // Padded bottom-right ONLY. faceGeometry's decoder maps detections
          // back assuming a top-left anchor; a centred pad shifts every
          // keypoint by half the padding, silently.
          const { data } = await sharp(buf)
            .resize(plan.resize.width, plan.resize.height)
            .extend({ ...plan.pad, background: { r: 0, g: 0, b: 0 } })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          return { data, width: DET_SIZE, height: DET_SIZE };
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
