import { EventEmitter } from "node:events";

/** @typedef {"scan"|"export"|"materialize"|"undo-move"|"enrich"|"transcode"} JobType */

/**
 * Job types that clear their own row when they SUCCEED.
 *
 * The user asked to watch a video and the video plays; they asked to read
 * metadata and the counts moved. There is nothing left to tell them, and the
 * acknowledgement is the cost: one row per clip, forever, until a browsing
 * session is reading its photos through a stack of ✓ notices.
 *
 * Only success self-clears. A FAILURE is news, and a job carrying an Undo is an
 * offer — both wait for a human.
 */
const SELF_CLEARING = new Set(["transcode", "enrich"]);

/** How many self-cleared jobs stay answerable by id. See `#recent`. */
const RECENT_MAX = 50;

class JobRegistry extends EventEmitter {
  #jobs = new Map();
  /**
   * Self-cleared jobs, kept out of `list()` but still answerable by `get()`.
   *
   * A job that removes itself the moment it succeeds is invisible to anyone who
   * SAMPLES the registry rather than subscribing to it: poll every 5ms and the
   * done state can land entirely between two polls, so the job goes from
   * "running" to "gone" and a caller waiting on it waits forever. "Only
   * event-driven consumers may observe a completion" is too sharp an edge to
   * leave lying around — `get(id)` keeps answering, and only the LIST (what the
   * UI renders, and what every SSE snapshot carries) forgets.
   *
   * Capped, and by a count rather than an age: a bound that doesn't depend on
   * the clock. Convert 200 clips in a session and the last 50 are still
   * answerable, which is far more than anything is waiting on.
   */
  #recent = new Map();
  #seq = 0;

  create(type, { label, total = 0 } = {}) {
    const id = `job-${++this.#seq}`;
    const job = {
      id,
      type,
      label: label ?? type,
      status: "running",
      done: 0,
      total,
      phase: "",
      result: null,
      error: null,
      controller: new AbortController(),
    };
    this.#jobs.set(id, job);
    this.#emit();
    return job;
  }
  update(id, patch) {
    const j = this.#jobs.get(id);
    if (!j) return;
    Object.assign(j, patch);
    this.#emit();
  }
  finish(id, result) {
    const j = this.#jobs.get(id);
    if (!j) return;
    j.status = "done";
    j.result = result ?? null;
    this.#emit();
    // A clean finish of a SELF_CLEARING job takes its own row away. Note the
    // ORDER: the "done" snapshot goes out FIRST, and only then does the row
    // disappear. Clients wait on a job by watching it leave "running"
    // (`waitForJob`), and a job that vanished without ever having been seen as
    // done never resolves — the loupe would sit on a spinner forever for a video
    // it had already converted. Two emits, and both of them matter.
    if (SELF_CLEARING.has(j.type)) {
      this.#jobs.delete(id);
      this.#remember(j);
      this.#emit();
    }
  }

  /** Keep the last RECENT_MAX self-cleared jobs answerable by id (FIFO). */
  #remember(job) {
    this.#recent.set(job.id, job);
    for (const id of this.#recent.keys()) {
      if (this.#recent.size <= RECENT_MAX) break;
      this.#recent.delete(id);
    }
  }
  fail(id, error) {
    const j = this.#jobs.get(id);
    if (!j) return;
    j.status = j.controller.signal.aborted ? "canceled" : "failed";
    j.error = String(error?.message ?? error);
    this.#emit();
  }
  cancel(id) {
    const j = this.#jobs.get(id);
    if (!j || j.status !== "running") return false;
    j.controller.abort();
    return true;
  }
  dismiss(id) {
    const j = this.#jobs.get(id);
    if (!j || j.status === "running") return false;
    this.#jobs.delete(id);
    this.#emit();
    return true;
  }
  /** Drop every job that has stopped, and report how many went. A running job
   * stays — "dismiss all" is not "cancel all", and silently killing work the
   * user started would be the worse surprise. Returns the count so the caller
   * can say what happened. */
  dismissAll() {
    let dismissed = 0;
    for (const [id, j] of this.#jobs) {
      if (j.status === "running") continue;
      this.#jobs.delete(id);
      dismissed += 1;
    }
    if (dismissed) this.#emit();
    return dismissed;
  }
  /** A live job, or a recently self-cleared one. `dismiss`/`cancel` deliberately
   * do NOT look here: you cannot cancel or dismiss what is already finished and
   * gone from the list. */
  get(id) {
    return this.#jobs.get(id) ?? this.#recent.get(id);
  }
  list() {
    return [...this.#jobs.values()].map(({ controller, ...rest }) => ({
      ...rest,
    }));
  }
  #emit() {
    this.emit("change", this.list());
  }
}

export const registry = new JobRegistry();
