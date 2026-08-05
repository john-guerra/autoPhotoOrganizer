import { monitorEventLoopDelay } from "node:perf_hooks";
import { trace, traceEnabled } from "./trace.js";

/**
 * How late the event loop is running, sampled continuously.
 *
 * ## The one measurement that settles #305
 *
 * "Lost the connection to the AutoGallery server" is what the client says when
 * `/api/health` does not answer within 4 s. Two very different things produce
 * it, and from the UI they are indistinguishable:
 *
 * 1. the server is ALIVE but cannot get round to the request — some CPU-bound
 *    work is hogging the loop, or N ffmpeg processes have taken every core and
 *    Node is not being scheduled;
 * 2. the server is fine and the BROWSER never sent the request — its
 *    per-origin connection pool was full of video streams.
 *
 * If the loop was late, it is (1) and the fix is on the server. If the loop was
 * on time through the whole outage, it is (2) and no amount of server-side
 * capping will ever help — which is worth knowing before writing a third fix.
 *
 * `monitorEventLoopDelay` is a libuv-level histogram: the cost is a timer in C
 * and no JS callback per sample, so this can run for the life of the process.
 * A `setInterval`-and-measure-the-drift loop, the obvious hand-rolled version,
 * cannot see a stall shorter than its own interval and is itself a JS callback
 * that has to be scheduled — during a stall, the thing you are measuring is
 * the thing that stops your measurement running.
 */

/**
 * Start sampling. Idempotent per returned handle; call `stop()` to end.
 *
 * @param {object} [o]
 * @param {number} [o.intervalMs] how often to inspect the histogram
 * @param {number} [o.stallMs] a max delay at or above this is worth an entry
 * @param {number} [o.heartbeatMs] emit a sample even when nothing is wrong
 * @param {Record<string, () => number>} [o.probes] extra numbers to record
 *   alongside — in-flight requests, live child processes. Read only at sample
 *   time, so a probe that throws costs one sample, not the watcher.
 * @returns {{stop: () => void, sample: () => void}}
 */
export function startEventLoopWatch({
  intervalMs = 1000,
  stallMs = 200,
  heartbeatMs = 15000,
  probes = {},
} = {}) {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  let lastHeartbeat = 0;

  function readProbes() {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [k, fn] of Object.entries(probes)) {
      try {
        out[k] = fn();
      } catch {
        // A diagnostic must not be able to break the thing it is watching.
      }
    }
    return out;
  }

  function sample() {
    const maxMs = Math.round(h.max / 1e6);
    const p99Ms = Math.round(h.percentile(99) / 1e6);
    const meanMs = Math.round(h.mean / 1e6);
    h.reset();
    const now = Date.now();
    const stalled = maxMs >= stallMs;
    if (!stalled && now - lastHeartbeat < heartbeatMs) return;
    lastHeartbeat = now;
    trace("loop", stalled ? "stall" : "tick", {
      maxMs,
      p99Ms,
      meanMs,
      rssMb: Math.round(process.memoryUsage.rss() / 1048576),
      ...readProbes(),
    });
  }

  const timer = setInterval(sample, intervalMs);
  // A background sampler must never be the reason the process stays alive.
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
      h.disable();
    },
    /** For tests, and for taking a reading at a moment you care about. */
    sample,
  };
}

/**
 * Express middleware: one entry per request, written when the socket closes.
 *
 * `close` rather than `finish`, and the distinction is the point: a request the
 * BROWSER gave up on never finishes, and "the client walked away after 9 s" is
 * a different diagnosis from "we answered in 9 s". Video playback is full of
 * the former by design (a `<video>` you navigate past aborts its range
 * request), so a log that could not tell them apart would read as a server
 * full of failures.
 *
 * @param {Record<string, () => number>} [probes] same shape as the watcher's
 */
export function traceHttp(probes = {}) {
  return function traceHttpMiddleware(req, res, next) {
    if (!traceEnabled()) return next();
    const started = performance.now();
    res.once("close", () => {
      /** @type {Record<string, number>} */
      const extra = {};
      for (const [k, fn] of Object.entries(probes)) {
        try {
          extra[k] = fn();
        } catch {
          /* a probe must not break a response */
        }
      }
      trace("http", res.writableFinished ? "done" : "aborted", {
        m: req.method,
        u: req.originalUrl,
        s: res.statusCode,
        ms: Math.round(performance.now() - started),
        ...extra,
      });
    });
    next();
  };
}
