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
  /** @param {string[]} _paths @returns {Promise<Float32Array[]>} */
  async embedImages(_paths) {
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
