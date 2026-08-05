import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEventLoopWatch, traceHttp } from "./eventLoopWatch.js";
import { startTrace, traceEntries, _resetTraceForTest } from "./trace.js";

/**
 * The event-loop watcher (#314).
 *
 * The point of these tests is not that a histogram works — Node's does. It is
 * that a REAL stall produces a `loop.stall` entry with a number on it, because
 * that number is the whole reason the watcher exists: it is what tells
 * "the server could not answer" apart from "the browser never asked", which
 * is the ambiguity #305 has been stuck on for three attempts.
 */

let dir;

beforeEach(async () => {
  _resetTraceForTest();
  dir = await mkdtemp(join(tmpdir(), "ag-loop-"));
  process.env.AUTOGALLERY_TRACE = "1";
  await startTrace({ dir });
});

afterEach(async () => {
  _resetTraceForTest();
  delete process.env.AUTOGALLERY_TRACE;
  await rm(dir, { recursive: true, force: true });
});

/** Hog the loop for real. Nothing else can measure what this is here to catch. */
function block(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* deliberately synchronous */
  }
}

describe("event-loop watch", () => {
  it("records a stall, with how late the loop actually ran", async () => {
    const w = startEventLoopWatch({
      intervalMs: 1e9, // never fires on its own; the test decides when to sample
      stallMs: 50,
    });
    // The histogram needs a moment of real time to have observed anything.
    await new Promise((r) => setTimeout(r, 20));
    block(150);
    await new Promise((r) => setTimeout(r, 20));
    w.sample();
    w.stop();

    const [stall] = traceEntries({ ch: "loop" });
    expect(stall.ev).toBe("stall");
    // A LOWER bound only. Asserting a range would be asserting the speed of
    // the machine, which is how a test becomes a CI flake.
    expect(stall.maxMs).toBeGreaterThanOrEqual(50);
    expect(stall.rssMb).toBeGreaterThan(0);
  });

  it("stays quiet when the loop is healthy, apart from a heartbeat", async () => {
    // A watcher that logs every second is one whose file is all watcher and no
    // evidence. Silence while nothing is wrong is a feature.
    const w = startEventLoopWatch({
      intervalMs: 1e9,
      stallMs: 50,
      heartbeatMs: 1e9,
    });
    await new Promise((r) => setTimeout(r, 20));
    w.sample(); // the first sample IS the first heartbeat
    w.sample(); // this one has nothing to say
    w.stop();
    expect(traceEntries({ ch: "loop" })).toHaveLength(1);
    expect(traceEntries({ ch: "loop" })[0].ev).toBe("tick");
  });

  it("carries the probes, so a stall says what else was running", async () => {
    const w = startEventLoopWatch({
      intervalMs: 1e9,
      stallMs: 0,
      probes: {
        procs: () => 7,
        boom: () => {
          throw new Error("nope");
        },
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    w.sample();
    w.stop();
    const [e] = traceEntries({ ch: "loop" });
    expect(e.procs).toBe(7);
    // A probe that throws costs its own value and nothing else — a diagnostic
    // must never be able to break the thing it is watching.
    expect(e.boom).toBeUndefined();
    expect(e.maxMs).toBeGreaterThanOrEqual(0);
  });
});

describe("http tracing", () => {
  /** The two lines of Express we actually depend on. */
  function fakeExchange({ finished }) {
    const handlers = {};
    return {
      req: { method: "GET", originalUrl: "/api/video/12?transcode=1" },
      res: {
        statusCode: 200,
        writableFinished: finished,
        once: (ev, fn) => (handlers[ev] = fn),
      },
      close: () => handlers.close?.(),
    };
  }

  it("tells a request we ANSWERED from one the browser abandoned", async () => {
    // This distinction is the reason it hooks `close` and not `finish`. A
    // `<video>` you navigate past aborts its range request by design, so a log
    // that could not tell the two apart would read as a server full of
    // failures — and the real abandonment, the one that matters, would be
    // invisible in the noise.
    const mw = traceHttp();
    for (const finished of [true, false]) {
      const x = fakeExchange({ finished });
      mw(x.req, x.res, () => {});
      x.close();
    }
    expect(traceEntries({ ch: "http" }).map((e) => e.ev)).toEqual([
      "done",
      "aborted",
    ]);
  });

  it("records the URL and the status, and how long it took", async () => {
    const mw = traceHttp({ procs: () => 2 });
    const x = fakeExchange({ finished: true });
    mw(x.req, x.res, () => {});
    x.close();
    expect(traceEntries({ ch: "http" })[0]).toMatchObject({
      m: "GET",
      u: "/api/video/12?transcode=1",
      s: 200,
      procs: 2,
    });
    expect(traceEntries({ ch: "http" })[0].ms).toBeGreaterThanOrEqual(0);
  });

  it("does nothing at all when tracing is off", async () => {
    _resetTraceForTest();
    const mw = traceHttp();
    const x = fakeExchange({ finished: true });
    let nexted = false;
    mw(x.req, x.res, () => (nexted = true));
    x.close();
    expect(nexted).toBe(true);
    expect(traceEntries()).toEqual([]);
  });
});
