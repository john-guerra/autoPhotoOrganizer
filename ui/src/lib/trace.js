/**
 * The browser's half of the flight recorder (#314).
 *
 * ## Why the client logs at all
 *
 * "Lost the connection to the AutoGallery server" is a CLIENT verdict: it
 * means `/api/health` did not answer inside 4 s. That verdict has two very
 * different causes and the banner is identical for both — the server could not
 * get round to answering, or the browser never sent the request because its
 * per-origin connection pool was full of video streams.
 *
 * Nothing on the server can tell those apart, because in the second case the
 * server sees no request at all. The only way to settle it is to have both
 * sides on one timeline: the client saying "I gave up at T+4s", the server
 * saying whether anything arrived, and the loop watcher saying whether it was
 * late. So these events are SHIPPED to the server rather than kept in the
 * console — one file, one clock, both halves.
 *
 * ## What this must never do
 *
 * Be the problem. It batches, it rate-limits, it drops rather than growing,
 * and a failed send is forgotten rather than retried — a retry queue during a
 * connection outage is exactly the wrong behaviour, since the outage is what
 * we are trying to record around.
 */

/** Batches waiting this long, or this many, whichever comes first. */
const FLUSH_MS = 2000;
const FLUSH_AT = 25;
/** Beyond this the oldest go: a queue that grows during an outage is a leak. */
const QUEUE_MAX = 200;
/**
 * Never send more often than this.
 *
 * Without it the "drops rather than growing" promise was empty: `flushAt` (25)
 * is below `max` (200) and `flush()` empties unconditionally, so the queue
 * could never reach the cap and the tracer simply SENT, without limit. An
 * `$effect` loop that throws — the trap CLAUDE.md documents at length — fires
 * `window.onerror` continuously, and every 25 of those became another POST
 * into the very event loop this thing exists to measure.
 *
 * With a floor on the interval, a storm is bounded to one request per second
 * and the overflow is dropped and COUNTED instead.
 */
const MIN_SEND_MS = 1000;

/**
 * @param {object} [o]
 * @param {(entries: any[]) => void} [o.send] how a batch leaves the browser
 * @param {() => number} [o.now]
 * @param {number} [o.flushMs]
 * @param {number} [o.flushAt]
 * @param {number} [o.max]
 */
export function createTracer({
  send = beaconSend,
  now = () => Date.now(),
  flushMs = FLUSH_MS,
  flushAt = FLUSH_AT,
  max = QUEUE_MAX,
  minSendMs = MIN_SEND_MS,
} = {}) {
  /** @type {any[]} */
  let queue = [];
  let timer = null;
  let dropped = 0;
  let lastSend = -Infinity;

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!queue.length) return;
    // Too soon: keep queuing (bounded by `max`) and come back. Without this
    // the tracer answers an error storm with a request storm.
    const wait = minSendMs - (now() - lastSend);
    if (wait > 0) {
      timer = setTimeout(flush, wait);
      return;
    }
    lastSend = now();
    const batch = queue;
    queue = [];
    if (dropped) {
      // Say so rather than silently shipping a log with holes in it. A gap you
      // cannot see is worse than a gap you can.
      batch.push({ ev: "trace-dropped", t: now(), n: dropped });
      dropped = 0;
    }
    try {
      send(batch);
    } catch {
      // Never let logging throw into whatever called it.
    }
  }

  return {
    /**
     * @param {string} ev
     * @param {Record<string, unknown>} [fields]
     * @param {string} [ch] a sub-channel, e.g. `video`, `health`
     */
    trace(ev, fields, ch) {
      queue.push({ ev, t: now(), ...(ch ? { ch } : {}), ...fields });
      if (queue.length > max) {
        queue.shift();
        dropped++;
      }
      if (queue.length >= flushAt) flush();
      else if (!timer) timer = setTimeout(flush, flushMs);
    },
    flush,
    /** For tests and diagnostics. */
    pending: () => queue.length,
  };
}

/**
 * `sendBeacon` first, because it is the one send that survives the page going
 * away — and the last events before a reload are often the interesting ones.
 * `keepalive` on fetch is the same promise for browsers that refuse the
 * beacon (a Blob type they dislike, or a full beacon queue).
 */
function beaconSend(entries) {
  const body = JSON.stringify({ entries });
  const url = "/api/debug/trace";
  if (
    navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))
  )
    return;
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // A log that cannot be delivered is not an error the user should hear
    // about, and during the outage this exists to record it is EXPECTED.
  });
}

/** The app's tracer. */
export const tracer = createTracer();

/**
 * Record one event from the UI.
 *
 * @param {string} ev what happened
 * @param {Record<string, unknown>} [fields]
 * @param {string} [ch] sub-channel — the server files it as `ui:<ch>`
 */
export const uiTrace = (ev, fields, ch) => tracer.trace(ev, fields, ch);

/**
 * Catch what nobody caught, and flush on the way out.
 *
 * `trackPageErrors` already fails an e2e run on an uncaught error, but only in
 * a test — in the real app an uncaught error is the thing the user reports as
 * "it just stopped", and it was previously visible only in a console nobody
 * has open.
 */
export function startUiTrace() {
  if (typeof window === "undefined") return () => {};
  const onError = (e) =>
    uiTrace(
      "uncaught",
      { msg: String(e.message ?? e), src: e.filename, line: e.lineno },
      "error"
    );
  const onRejection = (e) =>
    uiTrace("unhandled-rejection", { msg: String(e.reason) }, "error");
  const onHide = () => {
    if (document.visibilityState === "hidden") tracer.flush();
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  document.addEventListener("visibilitychange", onHide);
  uiTrace("start", { ua: navigator.userAgent }, "app");
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    document.removeEventListener("visibilitychange", onHide);
  };
}
