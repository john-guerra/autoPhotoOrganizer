/**
 * Supervising the projection worker (#232).
 *
 * The parent half of the contract in `worker.js`: spawn, stream phases and
 * progress, cancel by terminating, and settle EXACTLY once.
 */
import { Worker } from "node:worker_threads";

const WORKER_URL = new URL("./worker.js", import.meta.url);

/**
 * A ceiling that turns an OOM into a catchable job failure rather than a
 * process crash.
 *
 * Measured peaks: 824 MB at the default `minFaces: 2` (5,499 people) and
 * 1,825 MB with singletons included (25,758). 3 GB leaves room for a library
 * several times larger while still failing before the machine starts swapping.
 * Without it, an over-large library takes the whole server down with nothing
 * reported anywhere; with it, `ERR_WORKER_OUT_OF_MEMORY` reaches the user as a
 * sentence telling them to raise the minimum-faces filter.
 */
export const MAX_OLD_GENERATION_MB = 3072;

/**
 * @param {object} o
 * @param {Float32Array} o.data `n * dim`, row-major. Its buffer is COPIED then
 *   transferred, so the caller's array stays usable.
 * @param {number} o.dim
 * @param {number} o.n
 * @param {string} o.algorithm
 * @param {object} o.params from `defaultParams`
 * @param {AbortSignal} [o.signal]
 * @param {(phase: string) => void} [o.onPhase]
 * @param {(p: {done:number,total:number}) => void} [o.onProgress]
 * @returns {Promise<Float32Array>} length `2n`, interleaved x,y
 */
export function runProjection({
  data,
  dim,
  n,
  algorithm,
  params,
  signal,
  onPhase,
  onProgress,
}) {
  return new Promise((resolve, reject) => {
    // Copy rather than transfer the caller's own buffer: `personCentroids`
    // hands back a view the route may still want (its `ids` share nothing, but
    // a transferred buffer is detached and any later read throws).
    const buffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength
    );

    let worker;
    try {
      worker = new Worker(WORKER_URL, {
        workerData: { buffer, n, dim, algorithm, params },
        transferList: [buffer],
        resourceLimits: { maxOldGenerationSizeMb: MAX_OLD_GENERATION_MB },
      });
    } catch (e) {
      return reject(e);
    }

    /**
     * `error` and `exit` RACE to settle this promise, and a `terminate()`
     * produces both. Settle once, keyed on nothing but this flag — the
     * `#killChild` lesson at OnnxMLService.js:169, copied rather than
     * re-derived, because a double-settle there took the whole server down.
     */
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      fn(value);
    };

    function onAbort() {
      // A cancellation is an OUTCOME, not a failure. The job registry reads
      // this name to record "canceled" rather than "✗ 1 failed".
      const e = new Error("canceled");
      e.name = "AbortError";
      finish(reject, e);
    }

    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);

    worker.on("message", (msg) => {
      // A switch, not an if-chain: `{type:"embedding"}` is reserved for a
      // streaming layout, and an unknown frame must be ignored rather than
      // treated as an error.
      switch (msg?.type) {
        case "phase":
          onPhase?.(msg.phase);
          break;
        case "progress":
          onProgress?.({ done: msg.done, total: msg.total });
          break;
        case "done":
          finish(resolve, msg.xy);
          break;
        default:
          break;
      }
    });

    worker.on("error", (e) => {
      // Node reports an exceeded resourceLimit here. Translate it into
      // something the user can act on rather than a code they cannot.
      if (e?.code === "ERR_WORKER_OUT_OF_MEMORY") {
        const friendly = new Error(
          "This map needs more memory than is available. Raise the minimum number of faces to make it smaller, then try again."
        );
        friendly.cause = e;
        return finish(reject, friendly);
      }
      finish(reject, e);
    });

    worker.on("exit", (code) => {
      // Only reached when the worker ended without posting `done` — a normal
      // finish has already settled. Both branches are failures; they differ
      // only in what to tell a developer.
      finish(
        reject,
        new Error(
          code === 0
            ? "projection worker exited without producing a result"
            : `projection worker exited with code ${code}`
        )
      );
    });
  });
}
