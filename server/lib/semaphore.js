/**
 * A counting semaphore, for work that must not all run at once.
 *
 * ## Why this exists rather than the scheduler (#305)
 *
 * `server/pipeline/scheduler.js` has a resource lease that would fit — except
 * that it is priority-ordered, coalescing, and built around a `checkpoint()`
 * the caller awaits mid-run. Transcodes want none of that: they are
 * user-triggered, equal-priority, and atomic (an ffmpeg process either runs or
 * does not). They also want a cap greater than one, which the lease cannot
 * express — it holds a resource for exactly one run.
 *
 * So: the smallest thing that solves the problem, rather than bending a
 * mechanism that was built for sweeps.
 *
 * ## Fairness
 *
 * FIFO, deliberately. A LIFO queue would serve the clip you just arrived at
 * first, which sounds appealing for the loupe — but the caller already solves
 * that better by CANCELLING the ones it no longer wants (see Loupe.svelte's
 * withdrawal), and LIFO would starve whatever is at the back indefinitely.
 */

/**
 * @param {number} limit how many may run at once (>= 1)
 * @returns {{run: <T>(fn: () => Promise<T>) => Promise<T>, active: () => number, waiting: () => number}}
 */
export function createSemaphore(limit) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`semaphore limit must be a positive integer, got ${limit}`);
  }
  let active = 0;
  /** @type {Array<() => void>} */
  const queue = [];

  function release() {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  }

  return {
    /**
     * Run `fn` once a slot is free, and release the slot however it ends.
     *
     * `finally`, not a line after the await: a throw or an abort must give the
     * slot back, or the cap becomes a permanent deadlock whose only symptom is
     * a button that stops working. (The same reasoning as `withClusterLatch`,
     * and the same bug it was written to avoid.)
     */
    async run(fn) {
      if (active >= limit) {
        await new Promise((resolve) => queue.push(resolve));
      }
      active += 1;
      try {
        return await fn();
      } finally {
        release();
      }
    },
    /** For tests, diagnostics, and telling the user what they are waiting for. */
    active: () => active,
    waiting: () => queue.length,
  };
}
