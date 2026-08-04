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
 * - **One runnable at a time PER RESOURCE CLASS.** They contend for the ONNX
 *   worker, the SQLite writer and libvips; two of them on the same resource
 *   makes both slower and neither finishes sooner.
 *
 *   This rule was WRITTEN DOWN BEFORE IT WAS TRUE. Priority parking only ever
 *   parked a run of strictly LOWER priority, so two runs of equal priority —
 *   two scoped requests, or two background sweeps — both proceeded, and
 *   nothing here stopped them. What actually kept them apart was six
 *   hand-rolled `inFlight` booleans in `api.js`, each refusing its own route
 *   with a 409. The lease below is what lets those go (#279): a second request
 *   WAITS instead of being told no.
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
 * What a run needs exclusively, so two runs needing the same thing take turns.
 *
 * Named CLASSES rather than one global mutex, because they genuinely do not
 * conflict: hashing (`db-write`) and a face scan (`onnx`) can overlap all day
 * — one is IO and SHA-1, the other is a separate process — and making them
 * alternate would halve throughput for nothing. A run with no `resource` takes
 * no lease and never waits for one.
 */
export const RESOURCE = Object.freeze({
  /** The ONNX child: one model loaded, one queue. */
  ONNX: "onnx",
  /** The SQLite writer. WAL allows exactly one. */
  DB_WRITE: "db-write",
  /** sharp/libvips and the libuv threadpool it shares. */
  VIPS: "vips",
});

/**
 * @typedef {object} Run
 * @property {number} priority
 * @property {string} [resource] a RESOURCE class this run needs exclusively.
 *   Omitted means it contends for nothing.
 * @property {string} [key] coalescing key; a second submission with a key
 *   already queued is dropped, because it would recompute the same worklist
 * @property {string} [label] what this run IS, in the user's words ("Finding
 *   faces"). Passed to whatever it blocks, so a parked job can say what it is
 *   waiting FOR rather than only that it is waiting.
 * @property {(blockedBy: string|null) => void} [onPause] called when this run
 *   parks; `blockedBy` is the label of the run ahead, or null if it had none
 * @property {() => void} [onResume] called when it is let go
 */

export class Scheduler {
  /** @type {Set<Run>} everything submitted and not yet finished */
  #live = new Set();
  /** @type {Array<() => void>} parked checkpoints waiting to be re-checked */
  #waiters = [];
  /** @type {Map<string, Run>} resource class -> the run holding it */
  #leases = new Map();

  /**
   * Is anything of strictly higher priority than `run` outstanding?
   *
   * "Outstanding" rather than "running" on purpose: a SCOPED run that has been
   * submitted but has not reached its first checkpoint still has to win, or a
   * background sweep mid-batch would sail past the one checkpoint that mattered
   * and keep the worker for another batch.
   */
  #higherPending(run) {
    return this.#blocker(run) !== undefined;
  }

  /**
   * WHICH run is ahead of this one, not merely whether one is.
   *
   * The distinction is the whole of "a pause reason names the blocker": a
   * parked job could always say it was waiting, and never what for. Returns
   * `undefined` when nothing outranks it — deliberately distinct from a run
   * that outranks it but has no label.
   *
   * @param {Run} run
   * @returns {Run|undefined}
   */
  #blocker(run) {
    let best;
    for (const other of this.#live) {
      if (other === run || other.priority >= run.priority) continue;
      // The most urgent one, so the message names what will actually finish
      // first rather than whichever the Set happened to yield.
      if (!best || other.priority < best.priority) best = other;
    }
    return best;
  }

  /**
   * Who holds the resource `run` needs, if anyone else does.
   * @param {Run} run
   * @returns {Run|undefined}
   */
  #leaseHolder(run) {
    if (!run.resource) return undefined;
    const holder = this.#leases.get(run.resource);
    return holder && holder !== run ? holder : undefined;
  }

  /** @param {Run} run */
  #take(run) {
    if (run.resource) this.#leases.set(run.resource, run);
  }

  /** Give up the lease if this run holds it, and let the waiters look again.
   * @param {Run} run */
  #release(run) {
    if (!run.resource) return;
    if (this.#leases.get(run.resource) !== run) return;
    this.#leases.delete(run.resource);
    this.#wake();
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
      // RELEASE FIRST, before any chance of waiting. A run parked while holding
      // `db-write` blocks every other writer for as long as it stays parked —
      // and by design it can stay parked indefinitely. Holding a lease across
      // an await that may never resolve is the deadlock.
      this.#release(run);
      for (;;) {
        // Two reasons to wait, one loop: someone more urgent is outstanding, or
        // someone else holds the resource this run needs.
        const blocker = this.#blocker(run) ?? this.#leaseHolder(run);
        if (!blocker) break;
        if (!parked) {
          parked = true;
          run.onPause?.(blocker.label ?? null);
        }
        await new Promise((resolve) => this.#waiters.push(resolve));
      }
      // NO AWAIT between the check above and the take below, and that is the
      // whole of the mutual exclusion. JavaScript is single-threaded, so two
      // runs cannot both observe a free lease and both take it — but only for
      // as long as nothing yields in between. Do not add an await here.
      this.#take(run);
      if (parked) {
        parked = false;
        run.onResume?.();
      }
    };

    try {
      return await run.body({ checkpoint });
    } finally {
      this.#live.delete(run);
      this.#release(run);
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
