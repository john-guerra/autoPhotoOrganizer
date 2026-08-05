import { describe, it, expect } from "vitest";
import { createSemaphore } from "./semaphore.js";

/**
 * The cap that stops the loupe spawning an ffmpeg per keypress (#305).
 *
 * John held the arrow key through a folder of videos and the app reported
 * "Lost the connection to the AutoGallery server". That was not a crash: each
 * arrival started a conversion, `libx264` uses every core, and N of them
 * oversubscribe the CPU ~N× until Node cannot answer `/api/health` inside the
 * client's 4 s timeout.
 *
 * The withdrawal shipped in 2.19.40 is necessary and NOT sufficient, which is
 * the thing I got wrong: cancelling is a round-trip and starting is not, so
 * navigation starts work faster than it can withdraw it. Hence a real cap.
 */
describe("createSemaphore", () => {
  /** A promise you resolve by hand, so a test controls when work finishes. */
  function deferred() {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  }

  it("never runs more than `limit` at once", async () => {
    const sem = createSemaphore(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let peak = 0;
    const runs = gates.map((g) =>
      sem.run(async () => {
        peak = Math.max(peak, sem.active());
        await g.promise;
      })
    );
    // Let everything that can start, start.
    await new Promise((r) => setImmediate(r));
    expect(sem.active()).toBe(2);
    expect(sem.waiting()).toBe(2);

    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(sem.active()).toBe(0);
    expect(sem.waiting()).toBe(0);
  });

  it("gives the slot back when the work THROWS", async () => {
    // `finally`, not a line after the await. Leaking a slot turns the cap into
    // a permanent deadlock whose only symptom is a button that stops working —
    // the exact failure `withClusterLatch` was written to avoid.
    const sem = createSemaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("ffmpeg died");
      })
    ).rejects.toThrow("ffmpeg died");
    expect(sem.active()).toBe(0);

    // ...and the next caller is not blocked forever.
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });

  it("serves waiters FIFO", async () => {
    // Not LIFO, though LIFO would serve the clip you just arrived at first:
    // the caller solves that better by CANCELLING what it no longer wants, and
    // LIFO can starve whatever is at the back indefinitely.
    const sem = createSemaphore(1);
    const order = [];
    const first = deferred();
    const held = sem.run(async () => {
      order.push("held");
      await first.promise;
    });
    await new Promise((r) => setImmediate(r));
    const a = sem.run(async () => void order.push("a"));
    const b = sem.run(async () => void order.push("b"));
    first.resolve();
    await Promise.all([held, a, b]);
    expect(order).toEqual(["held", "a", "b"]);
  });

  it("refuses a nonsense limit rather than silently allowing everything", () => {
    expect(() => createSemaphore(0)).toThrow(/positive integer/);
    expect(() => createSemaphore(-1)).toThrow(/positive integer/);
    expect(() => createSemaphore(1.5)).toThrow(/positive integer/);
  });
});
