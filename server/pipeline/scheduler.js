/**
 * One worker, a priority queue, and a checkpoint the sweeps already had.
 *
 * Phase 2 of the unified scan pipeline (design §3). What John asked for:
 *
 * > "If I already started a scanning of photos for ML and I ask AutoGallery to
 * > scan a folder or selection, the other scanning should be paused, the ones I
 * > selected should be scanned and grouped right away, and when those finish it
 * > should continue the other scanning."
 *
 * ## A priority queue, not suspend/resume
 *
 * Suspend/resume needs either a saved cursor — which throws away the property
 * that makes these sweeps resumable at all, that the DATABASE is the checkpoint
 * and replay is a no-op — or a coroutine boundary. `runSweep` already HAS the
 * boundary: the top of its drain loop, where it calls `abortIfCanceled()` and
 * `await idle()`. Preemption is one more `await` at exactly that point and
 * nowhere else, so nothing mid-batch is ever interrupted.
 *
 * ## What "paused" costs the user
 *
 * A preempted run finishes its current batch, commits it, and blocks at the top
 * of the loop. Worst case is one batch: ~2.5s for faces (8 photos, the largest
 * decode), well under a second for the rest. Nothing is thrown away, which is
 * strictly better than cancel-and-restart.
 *
 * ## Rules, and the behaviours that fall out of them
 *
 * - **Exactly one runnable at a time.** They contend for CPU, the ONNX worker,
 *   libvips and one libuv pool; running two makes both slower and neither
 *   finishes sooner.
 * - **`checkpoint()` parks unless nothing of strictly higher priority is
 *   outstanding.** SCOPED (1) beats BACKGROUND (2).
 * - **Equal priority does not preempt — FIFO.** So "two scoped requests in a
 *   row" runs the first to completion INCLUDING its grouping, then the second,
 *   with the background sweep parked throughout because at every checkpoint it
 *   still sees higher-priority work outstanding. Requested behaviour, zero
 *   special-casing.
 * - **Starvation is real and must be visible.** A background run can be parked
 *   indefinitely if scoped requests keep arriving. That is correct — the user
 *   is asking for those — but the JobsPanel says so rather than leaving a bar
 *   that has not moved in ten minutes to be interpreted.
 */

/** Lower runs first. */
export const PRIORITY = Object.freeze({ SCOPED: 1, BACKGROUND: 2 });

/**
 * @typedef {object} Run
 * @property {number} priority
 * @property {string} [key] coalescing key; a second submission with a key
 *   already queued is dropped, because it would recompute the same worklist
 * @property {() => void} [onPause] called when this run parks
 * @property {() => void} [onResume] called when it is let go
 */

export class Scheduler {
  /** @type {Set<Run>} everything submitted and not yet finished */
  #live = new Set();
  /** @type {Array<() => void>} parked checkpoints waiting to be re-checked */
  #waiters = [];

  /**
   * Is anything of strictly higher priority than `run` outstanding?
   *
   * "Outstanding" rather than "running" on purpose: a SCOPED run that has been
   * submitted but has not reached its first checkpoint still has to win, or a
   * background sweep mid-batch would sail past the one checkpoint that mattered
   * and keep the worker for another batch.
   */
  #higherPending(run) {
    for (const other of this.#live) {
      if (other !== run && other.priority < run.priority) return true;
    }
    return false;
  }

  /** Let every parked checkpoint re-evaluate. Cheap: they re-check and re-park. */
  #wake() {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }

  /**
   * Run `body` under this scheduler.
   *
   * `body` receives `{ checkpoint }` and is expected to await it at a point
   * where parking is safe — for a sweep, the top of the drain loop.
   *
   * @template T
   * @param {Run & {body: (ctx: {checkpoint: () => Promise<void>}) => Promise<T>}} run
   * @returns {Promise<T | {coalesced: true}>}
   */
  async submit(run) {
    if (run.key && [...this.#live].some((r) => r.key === run.key)) {
      // Identical worklist, already queued. Saying so beats silently starting a
      // second pass that computes the same answer and races the first.
      return { coalesced: true };
    }
    this.#live.add(run);
    // Anything already parked may now be outranked by this one.
    this.#wake();

    let parked = false;
    const checkpoint = async () => {
      while (this.#higherPending(run)) {
        if (!parked) {
          parked = true;
          run.onPause?.();
        }
        await new Promise((resolve) => this.#waiters.push(resolve));
      }
      if (parked) {
        parked = false;
        run.onResume?.();
      }
    };

    try {
      return await run.body({ checkpoint });
    } finally {
      this.#live.delete(run);
      // Whatever was waiting on this one may now be free.
      this.#wake();
    }
  }

  /** For tests and diagnostics. */
  get liveCount() {
    return this.#live.size;
  }
}

export const scheduler = new Scheduler();
