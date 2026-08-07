/**
 * Cancel on a PARKED job, through the real parts (#344).
 *
 * The unit tests either side of this one each prove a piece: `scheduler.test.js`
 * that a park notices an abort, `sweep.test.js` that the drain loop stops at its
 * checkpoint, `scheduledJob.test.js` that a submit carries the signal at all.
 * Every one of those pieces was individually fine while the feature was broken —
 * the bug lived in the SEAM, which is the one place this repo's bugs keep coming
 * from, so it gets a test that spans it: a real `Scheduler`, the real `registry`,
 * the real `runSweep`, and the real `runFor` wiring the routes use.
 *
 * What it does NOT use is a route, a database or ONNX. Those add minutes and
 * would move the failure somewhere else; the seam under test is exactly these
 * four modules meeting.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Scheduler, PRIORITY, RESOURCE } from "../pipeline/scheduler.js";
import { runSweep } from "../ml/sweep.js";
import { registry } from "./registry.js";
import { runFor } from "./scheduledJob.js";

/** Next macrotask. Also what lets the sweep below be interrupted at all. */
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  for (const j of registry.list()) {
    if (j.status === "running" || j.status === "paused")
      registry.fail(j.id, "cleanup");
    registry.dismiss(j.id);
  }
});

describe("Cancel on a parked sweep (#344)", () => {
  it("stops it, without waiting for the run that parked it", async () => {
    const s = new Scheduler();
    const job = registry.create("faces", {
      label: "Finding faces",
      total: 1000,
    });

    let batches = 0;
    const bg = s
      .submit({
        priority: PRIORITY.BACKGROUND,
        resource: RESOURCE.ONNX,
        ...runFor(job),
        body: ({ checkpoint }) =>
          runSweep(job, {
            // A worklist that never empties, so ONLY a cancellation can end
            // this sweep — which is the situation being tested. The cap is a
            // safety net: if the cancel is ignored the test fails on the
            // assertions below rather than spinning forever.
            nextBatch: () => (batches < 5000 ? [{ id: ++batches }] : []),
            process: async (rows) => rows.length,
            markFailed: () => {},
            // A REAL macrotask per batch. With a synchronous idle the drain
            // loop is pure microtasks, which starves the timer queue — nothing
            // else in the test would ever get a turn, including the cancel.
            idle: settle,
            checkpoint,
          }),
      })
      .catch((e) => e);

    // Let it get going, so this is a preemption rather than a race at startup.
    await settle();
    await settle();
    const scoped = s.submit({
      priority: PRIORITY.SCOPED,
      resource: RESOURCE.ONNX,
      label: "Finding faces in 20 photos",
      // Never finishes on its own: the starvation case the scheduler's comments
      // call real and by design, and the case where the old code could park a
      // job forever.
      body: async ({ checkpoint }) => {
        await checkpoint();
        await never;
      },
    });
    await settle();
    await settle();

    // PARKED, and the row says what it is waiting for rather than sitting at a
    // bar that has not moved.
    const parked = registry.list().find((j) => j.id === job.id);
    expect(parked.status).toBe("paused");
    expect(parked.parked).toBe(true);
    expect(parked.pauseReason).toContain("Finding faces in 20 photos");
    // A live closure will resume into this row, so it must not be dismissable.
    expect(registry.dismiss(job.id)).toBe(false);
    const batchesWhenParked = batches;
    expect(batchesWhenParked).toBeGreaterThan(0);

    expect(registry.cancel(job.id)).toBe(true);
    const outcome = await Promise.race([
      bg,
      settle().then(() => "still parked"),
    ]);
    // The whole issue in one assertion: before the fix this stayed parked until
    // the scoped run finished, and the scoped run never does.
    expect(outcome).not.toBe("still parked");
    expect(outcome.name).toBe("AbortError");
    // And it did not pay for a whole further batch on the way out.
    expect(batches).toBe(batchesWhenParked);

    // The route's own `.catch` does this. The row must end as CANCELLED — a
    // cancellation is an outcome, not a failure — and it must be dismissable,
    // which it is not if `parked` survived the park it unwound from.
    registry.fail(job.id, outcome);
    const ended = registry.list().find((j) => j.id === job.id);
    expect(ended.status).toBe("canceled");
    expect(ended.parked).toBe(false);
    expect(ended.pauseReason).toBe("");
    expect(registry.dismiss(job.id)).toBe(true);

    releaseScoped();
    await scoped;
    expect(s.liveCount).toBe(0);
  });
});

/** The scoped run's leash, so the test can outlive it deliberately. */
let releaseScoped;
const never = new Promise((r) => (releaseScoped = r));
