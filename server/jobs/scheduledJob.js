/**
 * The four fields that connect a JOB to a scheduler RUN, in one place (#344).
 *
 * They were copied at all four `scheduler.submit` call sites in `api.js`, and
 * the copies were not identical — which is the whole reason this file exists.
 * Three of them said WHY the job parked and when it resumed; none of them
 * passed the job's `AbortSignal`, so `registry.cancel()` set a flag nobody was
 * listening to and a parked job could not be stopped at all.
 *
 * That is not a bug a fifth call site would have avoided by being written more
 * carefully — it is one every future call site would repeat, because "the run
 * needs the signal too" lived only in the scheduler's implementation. Spreading
 * one object makes the wiring all-or-nothing instead of remembered:
 *
 *     scheduler.submit({
 *       priority: ids ? PRIORITY.SCOPED : PRIORITY.BACKGROUND,
 *       resource: RESOURCE.ONNX,
 *       ...runFor(job),
 *       body: ({ checkpoint }) => …,
 *     })
 */
import { registry } from "./registry.js";

/**
 * What a parked job tells the user.
 *
 * Naming the blocker is the point (#282): "waiting" alone tells them the one
 * thing they can already see — the bar has not moved — and withholds the one
 * thing they cannot, which is what it is waiting FOR and so roughly how long.
 *
 * @param {string|null} blockedBy the label of the run ahead, if it had one
 */
export function waitingFor(blockedBy) {
  return blockedBy
    ? `Waiting for “${blockedBy}” to finish — it resumes on its own.`
    : "Waiting for another request to finish — it resumes on its own.";
}

/**
 * The scheduler-facing half of a job: its name, its cancellation, and the two
 * callbacks that keep its JobsPanel row honest while it waits its turn.
 *
 * @param {{id: string, label: string, controller: AbortController}} job
 * @returns {{label: string, signal: AbortSignal,
 *   onPause: (blockedBy: string|null) => void, onResume: () => void}}
 */
export function runFor(job) {
  return {
    label: job.label,
    // Without this a PARKED run cannot be cancelled. The park's only other exit
    // is "nothing outranks me", and under a stream of scoped requests that may
    // never come — starvation is by design here, a Cancel that silently does
    // nothing is not (#344).
    signal: job.controller.signal,
    // Say WHY it stopped rather than leaving a bar that has not moved to be
    // interpreted. `parked: true` marks it as a LIVE closure that will resume
    // into this same row, which is what stops `dismiss` deleting it.
    onPause: (blockedBy) =>
      registry.pause(job.id, waitingFor(blockedBy), { parked: true }),
    onResume: () => registry.resume(job.id),
  };
}
