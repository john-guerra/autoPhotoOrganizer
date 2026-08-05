import { describe, it, expect, vi } from "vitest";
import { createTracer } from "./trace.js";

/**
 * The browser's flight recorder (#314).
 *
 * The behaviours worth pinning are the ones that keep it from becoming the
 * fault it is recording: it batches, it drops rather than growing, it SAYS
 * when it dropped, and a failing send never reaches the caller.
 */

describe("ui tracer", () => {
  it("batches rather than sending one request per event", () => {
    const send = vi.fn();
    const t = createTracer({ send, flushAt: 3, flushMs: 1e9 });
    t.trace("a");
    t.trace("b");
    expect(send).not.toHaveBeenCalled();
    t.trace("c");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].map((e) => e.ev)).toEqual(["a", "b", "c"]);
  });

  it("sends a partial batch once the timer comes round", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const t = createTracer({ send, flushAt: 100, flushMs: 2000 });
    t.trace("a");
    vi.advanceTimersByTime(1999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("drops the OLDEST when the queue is full, and says how many", () => {
    // During the outage this exists to record, the send is exactly what does
    // not work — so the queue has to be bounded. A silent gap in a log is
    // worse than a gap you can see, hence the marker.
    const send = vi.fn();
    const t = createTracer({ send, flushAt: 1e9, flushMs: 1e9, max: 3 });
    for (const ev of ["a", "b", "c", "d", "e"]) t.trace(ev);
    t.flush();
    const batch = send.mock.calls[0][0];
    expect(batch.map((e) => e.ev)).toEqual(["c", "d", "e", "trace-dropped"]);
    expect(batch.at(-1).n).toBe(2);
  });

  it("swallows a failing send instead of throwing into the caller", () => {
    const t = createTracer({
      send: () => {
        throw new Error("offline");
      },
      flushAt: 1,
    });
    expect(() => t.trace("a")).not.toThrow();
  });

  it("stamps a time and keeps the sub-channel", () => {
    const send = vi.fn();
    const t = createTracer({ send, now: () => 42, flushAt: 1 });
    t.trace("ask", { id: 7 }, "video");
    expect(send.mock.calls[0][0][0]).toEqual({
      ev: "ask",
      t: 42,
      ch: "video",
      id: 7,
    });
  });

  it("flushing an empty queue sends nothing", () => {
    const send = vi.fn();
    createTracer({ send }).flush();
    expect(send).not.toHaveBeenCalled();
  });
});
