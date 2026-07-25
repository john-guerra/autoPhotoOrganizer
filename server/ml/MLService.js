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
   * Bytes, not paths — deliberately. Task 11's WebGPU host runs in a renderer
   * with no filesystem access, so the caller must read the file and hand over
   * the bytes; the boundary this crosses is a byte buffer, not a path string,
   * so safeResolve (server/lib/safeResolve.js) gains no new attack surface
   * from this method.
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
}
