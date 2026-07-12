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
 * Resolve once the given job id leaves "running" (done/canceled/failed).
 * Resolves immediately if the job is already terminal by the time this is
 * called (or once the next snapshot after subscribing already shows it
 * terminal — no polling, just an SSE-driven store subscription).
 * @param {string} id
 * @returns {Promise<object>} the terminal job
 */
export function waitForJob(id) {
  return new Promise((resolve) => {
    let unsub;
    unsub = jobs.subscribe((list) => {
      const job = list.find((j) => j.id === id);
      if (!job || job.status === "running") return;
      resolve(job);
      // `subscribe` invokes its callback synchronously on the first tick,
      // before the `subscribe(...)` call below has returned and assigned
      // `unsub` — defer the unsubscribe to a microtask in that case.
      if (unsub) unsub();
      else queueMicrotask(() => unsub?.());
    });
  });
}
