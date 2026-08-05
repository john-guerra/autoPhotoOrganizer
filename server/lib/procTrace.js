import { trace } from "./trace.js";

/**
 * How many child processes we have alive, and what they were for.
 *
 * ffmpeg's `libx264` uses every core it can get, so the interesting number is
 * not "is one running" but "how many at once" — that is what turns a
 * responsive machine into one where Node cannot get scheduled, and it is the
 * cause #305 was capped for (`TRANSCODE_SLOTS`). A cap you cannot observe is a
 * cap you cannot tell is being respected, and the transcode semaphore governs
 * only ONE of the three places this app spawns a binary.
 */

let live = 0;

/** Child processes currently alive. Read by the event-loop watcher. */
export function liveChildren() {
  return live;
}

/**
 * Count and record a child for its whole life.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {{bin?: string, why?: string}} [fields] what it is, in human terms
 * @returns {import("node:child_process").ChildProcess} the same child
 */
export function traceChild(child, fields = {}) {
  live++;
  const started = performance.now();
  trace("proc", "spawn", { ...fields, pid: child.pid, live });
  let settled = false;
  const end = (how, extra) => {
    // `error` and `close` can BOTH fire (a spawn that fails still closes), and
    // a double decrement would make the live count drift negative — which
    // would then read as "no children" during the exact burst we are here to
    // catch.
    if (settled) return;
    settled = true;
    live = Math.max(0, live - 1);
    trace("proc", how, {
      ...fields,
      pid: child.pid,
      ms: Math.round(performance.now() - started),
      live,
      ...extra,
    });
  };
  child.once("error", (e) => end("failed", { err: String(e?.message ?? e) }));
  child.once("close", (code, signal) =>
    end("exit", { code, signal: signal ?? undefined })
  );
  return child;
}

/** Test-only. */
export function _resetProcTraceForTest() {
  live = 0;
}
