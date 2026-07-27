/**
 * The vetted face model packs (#166) — a short allowlist, for the same reason
 * models.js is one: an arbitrary id is an arbitrary download onto the user's
 * machine, and a model whose output shape has not been checked writes plausible
 * vectors of the wrong dimension, which nothing downstream can detect.
 *
 * Each pack is TWO graphs, and they are always used together: a detector
 * (SCRFD — boxes plus five keypoints) and a recognizer (ArcFace — a 512-d
 * embedding of an aligned crop). Both packs expose identical input and output
 * shapes, which is the property that makes the choice a SETTING rather than a
 * fork in the code: swapping weights changes no decoding, no alignment, and no
 * storage.
 *
 * ## ⚠️ The licence is NOT settled, and this is the file that must say so
 *
 * `docs/superpowers/specs/2026-07-24-ml-signals-design.md` approved these on
 * the understanding that buffalo_l is "released research-use-only" and that a
 * "non-commercial licence, downloaded not bundled, with the licence shown" was
 * acceptable. Re-read at the source on 2026-07-27, that is no longer the whole
 * declaration. deepinsight/insightface's README says, verbatim:
 *
 *   - "The code of InsightFace is released under the MIT License. There is no
 *     limitation for both academic and commercial usage."
 *   - "The training data containing the annotation (and the models trained
 *     with these data) are available for non-commercial research purposes
 *     only."
 *   - And under a `2025-11-24 Update`: "For open-sourced face recognition
 *     models (e.g., buffalo_l package), please contact
 *     recognition-oss-pack@insightface.ai for licensing."
 *
 * So the MIT licence covers the CODE, not these weights — the same trap
 * models.js records for CLIP, where github.com/openai/CLIP is MIT and the
 * weights are a different artifact. And the November 2025 update goes further
 * than "non-commercial research": it names buffalo_l specifically and asks
 * users to contact them about licensing.
 *
 * AutoGallery ships releases through electron-updater to a real user, which is
 * not obviously "non-commercial research purposes" even though the app is free.
 * That is a question for John, not for a code comment to resolve — so this file
 * states what is declared, links the source, and leaves the decision visible
 * rather than burying it in a settings string that reads "research use only".
 *
 * The architecture deliberately survives either answer: everything upstream of
 * these bytes (faceGeometry, faceTensors, db/faces) is model-agnostic, so
 * substituting a permissively-licensed detector/recognizer pair is a change to
 * this file alone.
 */

/** Every ArcFace recognizer in this list emits 512 floats. Asserted per pack
 *  rather than assumed, because a mismatch writes right-width nonsense. */
export const FACE_DIM = 512;

export const FACE_MODELS = [
  {
    id: "buffalo_l",
    label: "buffalo_l (most accurate)",
    detector: {
      // SCRFD-10GF. The ONNX export has its output rows fixed for a 640x640
      // input — see faceGeometry.js's DET_SIZE, which is a property of these
      // weights and not a preference.
      file: "detection.onnx",
      url: "https://huggingface.co/immich-app/buffalo_l/resolve/main/detection/model.onnx",
      bytes: 16923827,
      sha256:
        "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
    },
    recognizer: {
      // ArcFace R50, trained on WebFace600K.
      file: "recognition.onnx",
      url: "https://huggingface.co/immich-app/buffalo_l/resolve/main/recognition/model.onnx",
      bytes: 174383860,
      sha256:
        "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",
    },
    dim: FACE_DIM,
    // END-TO-END per photo, not the detector's share: decode + letterbox +
    // detect + one recognition per face found. The component figures are 52 ms
    // to detect and 52 ms per face, and a naive sum of those UNDERSTATES the
    // real cost, because a photo also has to be decoded first and this
    // library averages ~1.9 faces per photo that has any.
    //
    // This number is rendered as "about N minutes" before the user commits to
    // a sweep (#215), so an optimistic one is not a harmless rounding — it is
    // the panel telling them something untrue about a decision they are
    // making. Measured on the real 31,976-photo library, darwin/arm64, CPU.
    approxMsPerPhoto: 170,
    approxMsPerFace: 52,
    // bytes / 1e6, DECIMAL MB not MiB — this is rendered before the user
    // starts the download, and decimal is what the OS shows while it runs.
    // Same reasoning as models.js's approxDownloadMB.
    approxDownloadMB: 191,
    licence:
      "Non-commercial research use only, declared by deepinsight/insightface — " +
      "and since 2025-11-24 that README asks users to contact " +
      "recognition-oss-pack@insightface.ai about licensing buffalo_l specifically",
    modelCardUrl: "https://github.com/deepinsight/insightface",
    note: "3x the detection cost and 17x the recognition cost of buffalo_s",
  },
  {
    id: "buffalo_s",
    label: "buffalo_s (much faster, smaller download)",
    detector: {
      // SCRFD-500MF. Same nine output heads at the same three strides as
      // buffalo_l's — verified against the graph, which is what lets one
      // decoder serve both.
      file: "detection.onnx",
      url: "https://huggingface.co/immich-app/buffalo_s/resolve/main/detection/model.onnx",
      bytes: 2524817,
      sha256:
        "5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a",
    },
    recognizer: {
      // MobileFaceNet, also 512-d.
      file: "recognition.onnx",
      url: "https://huggingface.co/immich-app/buffalo_s/resolve/main/recognition/model.onnx",
      bytes: 13616099,
      sha256:
        "9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f",
    },
    dim: FACE_DIM,
    // END-TO-END, and MEASURED LIVE rather than summed: a real sweep did 947
    // photos in 25 s on the full library, i.e. 26 ms each. The component
    // figures (17 ms detect, 3 ms per face) would have predicted 9 minutes
    // for the library where the truth is 14 — the panel said "about 9
    // minutes" with these before the live run corrected them. Summing
    // component costs omits the decode, which dominates.
    approxMsPerPhoto: 26,
    approxMsPerFace: 3,
    approxDownloadMB: 16,
    // Same pack policy, same repo, same November 2025 update — buffalo_s is
    // not named in it, but it is covered by the blanket non-commercial clause
    // on every model trained with their data.
    licence:
      "Non-commercial research use only, declared by deepinsight/insightface",
    modelCardUrl: "https://github.com/deepinsight/insightface",
    note: "MobileFaceNet rather than ArcFace R50; accuracy difference not yet measured on a real library",
  },
];

export const DEFAULT_FACE_MODEL_ID = "buffalo_s";

/**
 * The download source is a MIRROR, not InsightFace's own release.
 *
 * InsightFace distributes these as zips (buffalo_l.zip is 288.6 MB,
 * buffalo_s.zip 127.6 MB) carrying five models each, of which we use two —
 * 416 MB of transfer for 207 MB of files, plus an archive to extract. The
 * immich-app mirror serves the individual graphs.
 *
 * A mirror is a supply-chain question, which is why every entry above carries
 * a `sha256` and a `bytes`, recorded 2026-07-27 from a real download. The
 * downloader MUST check both before a graph is loaded, so a compromised or
 * silently-updated mirror fails loudly rather than embedding a different
 * model's opinion of who your family is. A test asserts every entry actually
 * carries a digest, because the failure mode of a missing one is that
 * verification silently passes.
 */
export const DOWNLOAD_SOURCE = "immich-app (Hugging Face mirror)";

/** @param {string} id @returns {typeof FACE_MODELS[number]} */
export function faceModelById(id) {
  const m = FACE_MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown face model: ${id}`);
  return m;
}

/**
 * Both graphs of one pack, as {name, url, bytes, sha256, file} — what a
 * downloader iterates and what a progress estimate sums.
 * @param {string} id
 */
export function faceModelFiles(id) {
  const m = faceModelById(id);
  return [
    { name: "detector", ...m.detector },
    { name: "recognizer", ...m.recognizer },
  ];
}
