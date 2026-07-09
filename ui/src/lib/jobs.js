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
