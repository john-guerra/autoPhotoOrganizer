/**
 * Single-flight latch for the projection (#232).
 *
 * Two concurrent runs with the same parameters would each spend four to twenty
 * seconds and 800 MB computing the same map, and the loser's work is written
 * and then immediately superseded. Two runs with DIFFERENT parameters would
 * each hold a worker, doubling the memory peak on a machine already running
 * Electron, Chromium and libvips.
 *
 * Mirrors `withClusterLatch` in ml/faceClusters.js, including the reason its
 * release is in a `finally` rather than on the line after the await: leaving
 * the flag set makes every later run a silent no-op for the life of the
 * process, and the only symptom is a button that does nothing.
 */

let inFlight = false;

/** @returns {boolean} */
export function isProjectionInFlight() {
  return inFlight;
}

/** Tests only — mirrors `_resetClusterForTest`. */
export function _resetProjectionForTest() {
  inFlight = false;
}

/**
 * Take the latch, run `fn`, release it on EVERY exit path.
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export async function withProjectionLatch(fn) {
  inFlight = true;
  try {
    return await fn();
  } finally {
    inFlight = false;
  }
}
