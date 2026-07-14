/**
 * Live background-jobs store, fed by one SSE connection to
 * `/api/jobs/events` (the server sends the full jobs snapshot as a JSON
 * array on connect and again on every change).
 */

import { writable } from "svelte/store";

/** @type {import('svelte/store').Writable<Array<object>>} */
export const jobs = writable([]);

let eventSource = null;

/**
 * Open the SSE connection. Idempotent — a second call is a no-op as long as
 * a connection already exists. Exposed (rather than only auto-run) so tests
 * can inject a fake `EventSource` constructor instead of hitting the network;
 * in a non-browser environment (e.g. vitest's node environment) the default
 * lookup resolves to `null` and this quietly does nothing.
 * @param {typeof EventSource | null} [EventSourceCtor]
 */
export function connectJobsStream(
  EventSourceCtor = typeof EventSource !== "undefined" ? EventSource : null
) {
  if (!EventSourceCtor || eventSource) return eventSource;
  eventSource = new EventSourceCtor("/api/jobs/events");
  eventSource.onmessage = (event) => {
    jobs.set(JSON.parse(event.data));
  };
  return eventSource;
}

connectJobsStream();

/** Statuses that mean a job has stopped for good and won't change again. */
const TERMINAL_STATUSES = new Set(["done", "canceled", "failed"]);

/**
 * One-shot edge detector for finished background jobs. Returns the jobs of
 * `type` in `list` that have just reached a terminal state and hadn't been
 * seen before, marking each id in `handled` so a later snapshot won't return
 * it again. Lets a caller fire a single refresh when e.g. an `undo-move` job
 * completes, instead of re-firing on every subsequent SSE store snapshot.
 * Canceled/failed count as terminal too — a partially-completed undo still
 * moved some files, so the UI is stale and must refresh either way.
 * @param {Array<object>} list current jobs snapshot
 * @param {string} type job type to watch (e.g. "undo-move")
 * @param {Set<string>} handled ids already acted on (mutated in place)
 * @returns {Array<object>} the newly-finished jobs of that type
 */
export function takeNewlyFinished(list, type, handled) {
  const fresh = [];
  for (const job of list) {
    if (
      job.type === type &&
      TERMINAL_STATUSES.has(job.status) &&
      !handled.has(job.id)
    ) {
      handled.add(job.id);
      fresh.push(job);
    }
  }
  return fresh;
}

/**
 * Build a specific, actionable message for a *synchronous* undo failure — the
 * POST rejecting before an undo-move job is ever created (a 413 when the
 * manifest is too big, a network drop, a server reject). A background-job
 * failure surfaces via the job's own `error`; this covers the fire-and-forget
 * gap where the rejection would otherwise be console-only (issue #89).
 * @param {(Error & {status?: number}) | undefined} err the thrown error
 * @param {number} fileCount manifest length, for the size-specific 413 message
 * @returns {string} a user-facing message ending in what to do next
 */
export function undoFailureMessage(err, fileCount) {
  if (err?.status === 413) {
    return `Undo failed: the move record was too large to send (${fileCount} files) — retry from the jobs panel.`;
  }
  const reason = err?.message || "unknown error";
  return `Undo failed: ${reason} — retry from the jobs panel.`;
}

/**
 * Has `done` crossed another multiple of `step` since `prev`?
 *
 * The gate for refreshing the grid *while* a scan is still walking the disk.
 * Progress ticks arrive per file, and reloading the feed on every one would be
 * a page of work per photo; this fires once per `step` photos instead, so the
 * cost is bounded no matter how big the folder is. A plain counter comparison,
 * not a timer — the refresh rate follows the scan's real progress rather than a
 * wall-clock guess about it.
 *
 * @param {number} prev the `done` count at the last refresh
 * @param {number} done the job's current `done` count
 * @param {number} step how many newly-indexed photos are worth a refresh
 */
export function crossedStep(prev, done, step) {
  if (!Number.isFinite(done) || done <= 0 || step <= 0) return false;
  return Math.floor(done / step) > Math.floor(Math.max(0, prev) / step);
}

/**
 * Resolve once the given job id leaves "running" (done/canceled/failed).
 * Resolves immediately if the job is already terminal by the time this is
 * called (or once the next snapshot after subscribing already shows it
 * terminal — no polling, just an SSE-driven store subscription).
 *
 * `onProgress` is called with each RUNNING snapshot of the job, which is what
 * lets the grid fill in while a scan is still walking (the server has streamed
 * this all along; the client used to throw it away and await the whole job).
 *
 * @param {string} id
 * @param {(job: object) => void} [onProgress]
 * @returns {Promise<object>} the terminal job
 */
export function waitForJob(id, onProgress) {
  return new Promise((resolve) => {
    let unsub;
    unsub = jobs.subscribe((list) => {
      const job = list.find((j) => j.id === id);
      if (!job) return;
      if (job.status === "running") {
        onProgress?.(job);
        return;
      }
      resolve(job);
      // `subscribe` invokes its callback synchronously on the first tick,
      // before the `subscribe(...)` call below has returned and assigned
      // `unsub` — defer the unsubscribe to a microtask in that case.
      if (unsub) unsub();
      else queueMicrotask(() => unsub?.());
    });
  });
}
