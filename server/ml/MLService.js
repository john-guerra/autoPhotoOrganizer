/**
 * The ML capability seam, mirroring server/processing/ProcessingService.js
 * deliberately — same shape of problem, and the codebase already knows how to
 * read that shape. ProcessingService.js:11 always named a future ML sidecar;
 * this is it, and keeping it abstract is what leaves the Python swap open.
 *
 * Every method throws here. An implementation that cannot do one of these is
 * expected to keep throwing rather than return a plausible empty answer — a
 * silently-empty embedding set is the "reports plausible numbers and is wrong"
 * failure this program exists to avoid.
 *
 * @typedef {{box: [number, number, number, number], score: number, vec: Float32Array}} Face
 */

/**
 * The flag that says "this failure is the HOST's, not the photo's".
 *
 * Why a tag and not a string match: an error that crosses the worker's stdio
 * boundary is reconstructed from `String(e.message)` — the errno is GONE, and
 * the message is whatever transformers.js/ORT happened to say this release.
 * A sweep matching on that text would be one dependency bump away from
 * classifying a dead model download as "this photo cannot be read" and
 * sentinel-marking the entire library (#161 final review, Critical 1). The
 * side that KNOWS ("I am the ML host and I could not do this at all") is the
 * side that should say so, so the tag is attached where the error crosses out
 * of the host — see OnnxMLService's #onData/#request/#killChild — and at the
 * call site in embedSweep, which covers any injected host that predates this
 * (a test double, a future Python sidecar) without asking it to cooperate.
 *
 * A plain own property, not a subclass: the errors being tagged are created
 * elsewhere (JSON.parse of a worker reply, a timeout, an injected stub), so
 * there is nothing to subclass at the point we learn the fact. Same technique
 * runSweep already uses for `e.name = "AbortError"`.
 */
const HOST_FAILURE = "mlHostFailure";

/**
 * Tag `err` as a host-level failure and return it (so callers can
 * `throw markHostFailure(e)`). Never throws: a frozen/sealed error still
 * comes back, just untagged — misclassifying is a bug, but crashing the
 * sweep while trying to classify would be a worse one.
 * @template T
 * @param {T} err
 * @returns {T}
 */
export function markHostFailure(err) {
  try {
    if (err && typeof err === "object") err[HOST_FAILURE] = true;
  } catch {
    // sealed/frozen error object — leave it alone
  }
  return err;
}

/** @param {any} err @returns {boolean} */
export function isHostFailure(err) {
  return err?.[HOST_FAILURE] === true;
}
export class MLService {
  /**
   * @param {Buffer[]} _buffers JPEG bytes, one per image
   * @returns {Promise<Float32Array[]>}
   *
   * Bytes, not paths — deliberately. The host runs out-of-process (a spawned
   * child today; see OnnxMLService — any future host is free to be a
   * different kind of process, e.g. one with no filesystem access at all)
   * and the caller already has the file open for thumbnailing, so it reads
   * the bytes here rather than handing the host a path to open itself; the
   * boundary this crosses is a byte buffer, not a path string, so safeResolve
   * (server/lib/safeResolve.js) gains no new attack surface from this method.
   */
  async embedImages(_buffers) {
    throw new Error("MLService.embedImages is not implemented");
  }
  /** @param {string[]} _strings @returns {Promise<Float32Array[]>} */
  async embedTexts(_strings) {
    throw new Error("MLService.embedTexts is not implemented");
  }
  /** @param {string} _path @returns {Promise<Face[]>} */
  async detectFaces(_path) {
    throw new Error("MLService.detectFaces is not implemented");
  }

  /**
   * Human-readable label for the compute backend THIS instance actually runs
   * inference on — surfaced in the settings/status panel (#161, Task 12). The
   * one hard rule: it must never claim an accelerator that is not really
   * running (see OnnxMLService.describeProvider, which is the whole reason
   * this method exists rather than the static string server/api.js used to
   * hardcode — that string was truthful only by accident, back when the
   * worker hardcoded `device: "cpu"` and never tried anything else). Unlike
   * the methods above, this does NOT throw by default — a host that hasn't
   * overridden it gets an honest "unknown" rather than crashing a status GET,
   * but every real host (OnnxMLService) overrides it with the truth.
   * @returns {Promise<string>}
   */
  async describeProvider() {
    return "unknown ML provider";
  }
}
