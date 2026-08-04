/**
 * Assert that a function never holds the event loop for longer than `ms`.
 *
 * ## Why this exists
 *
 * "Remember to yield" has failed three times in this repo (#231, #279, #281),
 * and the test written to protect it did not catch any of them. That test
 * (`faceGrouping.test.js`) injects its own `yieldEvery` and asserts the loop
 * honours **the injected budget**. It says nothing about the shipped constant
 * and nothing about milliseconds — it would pass identically if
 * `YIELD_COMPARISONS` were a hundred million, which is exactly the failure it
 * was meant to prevent.
 *
 * The lesson, from `docs/ARCHITECTURE-REVIEW-2026-08-04.md` §9: **assert a TIME
 * budget against the SHIPPED constants**, never a comparison budget against an
 * injected one. A comparison budget is a proxy; the user experiences
 * milliseconds.
 *
 * ## How it measures
 *
 * A `setInterval` at `tickMs` is a probe: if the loop is free the callback
 * fires roughly on time, and if something is hogging it fires late by however
 * long the hog ran. Worst lateness across the run is the answer. This is the
 * same trick #231 used to produce its original measurement, packaged so the
 * next person does not rewrite it.
 *
 * ## Reading a failure
 *
 * A failure means some synchronous stretch inside `fn` exceeded the budget. It
 * does NOT tell you where — add finer yields, or bisect by shrinking the input.
 * The most common cause in this codebase is a loop that yields between OUTER
 * items while one inner item is itself expensive (`bestPerson` compared a face
 * against every centroid in one call: granularity of one face, ~12 ms at
 * 25,758 people, whatever the budget said).
 *
 * ## Caveats, because a green result can mislead
 *
 * - **CI machines are noisy.** Leave headroom; a budget tuned to the millisecond
 *   on a laptop will flake on a shared runner.
 * - **This measures the loop, not throughput.** Yielding more costs throughput
 *   (measured: ~35% for a 100× smaller budget). A test that only checks
 *   latency will happily accept code that never finishes.
 * - **It needs a realistic n.** At 100 faces everything passes. The point is to
 *   run it against a fixture large enough that the loop has to work.
 *
 * @param {number} ms worst tolerated block
 * @param {() => Promise<unknown>} fn
 * @param {{tickMs?: number}} [opts]
 * @returns {Promise<{worstMs: number, ticks: number, result: unknown}>}
 */
export async function measureBlocking(ms, fn, { tickMs = 5 } = {}) {
  let worst = 0;
  let ticks = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const late = now - last - tickMs;
    if (late > worst) worst = late;
    last = now;
    ticks += 1;
  }, tickMs);
  // Unref so a hung `fn` cannot keep the process alive on its own.
  timer.unref?.();
  try {
    const result = await fn();
    return { worstMs: worst, ticks, result };
  } finally {
    clearInterval(timer);
  }
}

/**
 * `measureBlocking`, as an assertion.
 * @param {number} ms
 * @param {() => Promise<unknown>} fn
 * @param {{tickMs?: number, label?: string}} [opts]
 */
export async function expectNoBlockOver(ms, fn, { tickMs = 5, label } = {}) {
  const { worstMs, ticks } = await measureBlocking(ms, fn, { tickMs });
  if (ticks === 0) {
    throw new Error(
      `expectNoBlockOver${label ? ` (${label})` : ""}: the probe never fired — ` +
        `the work finished too fast to measure, so this proves nothing. ` +
        `Use a bigger fixture.`
    );
  }
  if (worstMs > ms) {
    throw new Error(
      `expectNoBlockOver${label ? ` (${label})` : ""}: held the event loop for ` +
        `${worstMs.toFixed(1)}ms, budget ${ms}ms (${ticks} probes at ${tickMs}ms). ` +
        `Something inside is synchronous for longer than a frame.`
    );
  }
  return worstMs;
}
