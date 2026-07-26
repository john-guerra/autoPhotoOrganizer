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
