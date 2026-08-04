/**
 * Who gets the disk first: you, or the sweep.
 *
 * The metadata sweep and the thumbnail endpoints compete for the same
 * ProcessingService (sharp/exiftool/ffmpeg). A full-library sweep is thousands
 * of extractions deep, so with no arbitration it simply wins: measured on a 114k
 * library, thumbnails went from ~15ms to ~90ms while a sweep ran, and the grid
 * showed "N thumbnails failed to load" as slow tiles were abandoned mid-scroll.
 *
 * The user's scrolling is INTERACTIVE — they are waiting on it. The sweep is
 * BACKGROUND — nobody is. So the sweep waits for the interactive work instead of
 * racing it: `whenIdle()` resolves the moment nothing interactive is in flight.
 *
 * This is state-driven, not timer-driven: there is no "settle window" to tune
 * and nothing that fires early on a slow disk. It holds for exactly as long as
 * the user is actually being served, and not one tick longer.
 */

let inFlight = 0;
/** @type {Array<() => void>} */
let waiters = [];

/** Express middleware: mark a route as interactive (the user is waiting on it). */
export function interactiveRoute(_req, res, next) {
  inFlight++;
  // 'close' rather than 'finish': a request the browser abandoned mid-scroll —
  // the exact case that produced the failed-thumbnail counter — must release its
  // claim too, or the sweep would wait forever on a request nobody wants.
  res.once("close", release);
  next();
}

function release() {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0) {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  }
}

/**
 * Resolves once no interactive request is in flight.
 *
 * ## The idle path yields a MACROTASK, and that is the whole point
 *
 * This used to `return Promise.resolve()` when nothing was in flight, which
 * awaits as a **microtask** — and microtasks run to exhaustion *before* the
 * event loop reaches timers or I/O. So a sweep whose only yield was
 * `await idle()` handed control to nobody: measured at 10.9 million awaits
 * producing **zero** macrotasks (`docs/ARCHITECTURE-REVIEW-2026-08-04.md` §2
 * M11).
 *
 * That is why "let the user go first" did not work, and why adding this gate
 * to a loop that lacked it would have changed nothing while looking like a
 * fix. `nearDupeSweep` and `backfillPlaces` both relied on it as their only
 * yield.
 *
 * `setImmediate` is the cheap macrotask — it runs after I/O callbacks in the
 * current turn, so a pending request is served before the caller resumes. The
 * cost is one loop turn per call, which is what a yield is supposed to cost.
 *
 * Fixed HERE rather than at each call site so a future sweep cannot get it
 * wrong by writing the obvious thing.
 *
 * @returns {Promise<void>}
 */
export function whenIdle() {
  if (inFlight === 0) {
    return new Promise((resolve) => setImmediate(resolve));
  }
  return new Promise((resolve) => waiters.push(resolve));
}

/** In-flight interactive requests. Exposed for tests and diagnostics. */
export function interactiveInFlight() {
  return inFlight;
}

/** Test-only: drop all state between cases. */
export function _resetInteractiveForTest() {
  inFlight = 0;
  waiters = [];
}
