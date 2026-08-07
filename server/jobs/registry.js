import { EventEmitter } from "node:events";
import { trace } from "../lib/trace.js";

/** @typedef {"scan"|"export"|"materialize"|"undo-move"|"enrich"|"transcode"|"hash"|"embed"|"faces"|"face-download"|"face-cluster"|"projection"} JobType */

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
const SELF_CLEARING = new Set(["transcode", "enrich", "hash", "embed"]);

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
      pauseReason: "",
      result: null,
      error: null,
      controller: new AbortController(),
    };
    this.#jobs.set(id, job);
    // Lifecycle only — never `update`, which is where progress ticks live and
    // would drown the log in a thousand lines per scan. What a reader needs
    // from a job is when it began, when it ended, and how.
    trace("job", "create", { id, type, label: job.label, total });
    this.#emit();
    return job;
  }
  update(id, patch) {
    const j = this.#jobs.get(id);
    if (!j) return;
    Object.assign(j, patch);
    this.#emit();
  }
  /**
   * A job that has STOPPED is not parked, whatever it was doing a moment ago.
   *
   * `parked` is a live-closure flag, and `dismiss`/`dismissAll` refuse while it
   * is set — correctly, since a parked run is work that still exists. But a run
   * that unwinds STRAIGHT OUT of a park (now reachable: cancelling a parked job
   * finally stops it, #344) would keep the flag forever and leave a finished
   * row nothing could ever clear. Every terminal transition goes through here.
   *
   * @param {object} j
   */
  #settle(j) {
    j.parked = false;
    j.pauseReason = "";
  }

  finish(id, result) {
    const j = this.#jobs.get(id);
    if (!j) return;
    j.status = "done";
    this.#settle(j);
    j.result = result ?? null;
    trace("job", "done", { id, type: j.type, done: j.done, total: j.total });
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
  /**
   * A COOPERATIVE cancel: the work stopped when asked and RETURNED what it got
   * through, rather than throwing.
   *
   * There was no way to record that, and the two existing workarounds each
   * lose half of it. Throwing `new Error("canceled")` (four call sites) gets
   * the status right and discards the partial counts; `finish(id, {cancelled:
   * true})` (one call site) keeps the counts and reports the job as ✓ done,
   * which is the Finding-6 mistake in the other direction — telling someone
   * who pressed Stop that it completed.
   *
   * Both halves matter for a destructive action: "stopped after removing
   * 40,000 of 125,000 photos" is what tells the user the library is now in a
   * partial state, and it is exactly what a bare ✗ or ✓ withholds.
   *
   * @param {string} id
   * @param {object} [result] whatever the work did manage to do
   */
  stopped(id, result) {
    const j = this.#jobs.get(id);
    if (!j) return;
    j.status = "canceled";
    this.#settle(j);
    j.result = result ?? null;
    trace("job", "stopped", { id, type: j.type, done: j.done });
    this.#emit();
  }
  fail(id, error) {
    const j = this.#jobs.get(id);
    if (!j) return;
    j.status = j.controller.signal.aborted ? "canceled" : "failed";
    this.#settle(j);
    j.error = String(error?.message ?? error);
    trace("job", j.status, { id, type: j.type, err: j.error });
    this.#emit();
  }
  /**
   * Park a job that is waiting on something, WITHOUT pretending it failed.
   *
   * There was no such status, so `kickHashSweep` and `kickEmbedSweep` faked one
   * with `status: "failed", error: "paused — …"` — and the JobsPanel counts
   * `failed` as broken, so an unmounted drive rendered a red "1 failed" (#260).
   * A host condition says nothing about your photos, and that is precisely the
   * Finding-6 mistake the panel's own comment condemns for cancellation.
   *
   * ## Two kinds of paused, and only one may be dismissed
   *
   * `parked: true` means a LIVE CLOSURE is sitting on a checkpoint waiting for
   * the scheduler (#257). Its row must survive, because the work resumes into
   * that same job — dismissing it makes running work invisible.
   *
   * The default, `parked: false`, is a sweep that has already RETURNED: it
   * stopped, and the next scan re-kicks it as a NEW job. Those must stay
   * dismissable, and this is not theoretical — refusing them stranded 41
   * undismissable "Hashing library contents" rows in the api tests.
   *
   * @param {string} id
   * @param {string} reason shown to the user; say what to DO about it
   * @param {{parked?: boolean}} [opts]
   */
  pause(id, reason, { parked = false } = {}) {
    const j = this.#jobs.get(id);
    if (!j || j.status !== "running") return false;
    j.status = "paused";
    trace("job", "paused", { id, type: j.type, reason: String(reason ?? "") });
    j.pauseReason = String(reason ?? "");
    j.parked = parked;
    this.#emit();
    return true;
  }
  resume(id) {
    const j = this.#jobs.get(id);
    if (!j || j.status !== "paused") return false;
    j.status = "running";
    j.pauseReason = "";
    j.parked = false;
    this.#emit();
    return true;
  }
  cancel(id) {
    const j = this.#jobs.get(id);
    // `paused` too, or a paused job is UNCANCELLABLE — which fails contract 2
    // outright ("a working Cancel"), and would land the moment #257 introduces
    // a real pause. Cancelling a parked job is the most likely thing a user
    // does with one.
    if (!j || (j.status !== "running" && j.status !== "paused")) return false;
    trace("job", "cancel", { id, type: j.type, done: j.done });
    j.controller.abort();
    return true;
  }
  dismiss(id) {
    const j = this.#jobs.get(id);
    // Paused IS dismissable, and that is a correction to this issue's own
    // first instinct (#260 originally said it should be refused, "it has not
    // finished"). The evidence says otherwise: all three of today's pausers
    // have already RETURNED from their sweep when they pause — the work
    // stopped and will be re-kicked as a NEW job on the next scan — so
    // refusing dismiss stranded rows forever. It showed up immediately as 41
    // undismissable "Hashing library contents" rows in the api tests.
    //
    // A genuinely PARKED run (#257, where a live closure is waiting on a
    // scheduler) is a different thing, and when it arrives it needs to keep
    // its row. That distinction belongs to the phase that introduces it, not
    // to a status flag guessed at in advance.
    //
    // IT HAS NOW ARRIVED, and `j.parked` is the distinction. A parked job is
    // running work that happens to be waiting its turn; dismissing it would
    // delete the only thing telling the user that work still exists, and it
    // would come back on resume with no row to update.
    if (!j || j.status === "running" || j.parked) return false;
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
      // Same rule as `dismiss`: a parked run is work in progress that is
      // merely waiting its turn, so a sweep of the finished rows must not
      // take it. Missing this here would make "Dismiss all" the back door
      // into exactly the state `dismiss` refuses.
      if (j.status === "running" || j.parked) continue;
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
