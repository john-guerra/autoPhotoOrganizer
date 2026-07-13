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

/** Resolves once no interactive request is in flight (immediately, if none is).
 * @returns {Promise<void>} */
export function whenIdle() {
  if (inFlight === 0) return Promise.resolve();
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
