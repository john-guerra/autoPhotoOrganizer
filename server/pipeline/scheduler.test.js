import { describe, it, expect } from "vitest";
import { Scheduler, PRIORITY } from "./scheduler.js";

/** Resolve on the next macrotask, so parked promises get a chance to settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * A fake sweep: awaits `checkpoint()` before each of `n` batches and records
 * every batch it completes into the shared `log`. That mirrors runSweep's real
 * shape — the checkpoint is at the TOP of the loop, so a park never interrupts
 * a batch in flight.
 */
function fakeSweep(name, n, log) {
  return async ({ checkpoint }) => {
    for (let i = 0; i < n; i++) {
      await checkpoint();
      log.push(`${name}${i}`);
      await settle();
    }
    return name;
  };
}

describe("Scheduler — a scoped request preempts the sweep (#257)", () => {
  it("parks a BACKGROUND run while a SCOPED one is outstanding", async () => {
    const s = new Scheduler();
    const log = [];
    const paused = [];

    const bg = s.submit({
      priority: PRIORITY.BACKGROUND,
      onPause: () => paused.push("pause"),
      onResume: () => paused.push("resume"),
      body: fakeSweep("bg", 4, log),
    });
    // Let the sweep get going, so this is a real preemption rather than a race
    // at startup.
    await settle();
    await settle();
    const scoped = s.submit({
      priority: PRIORITY.SCOPED,
      body: fakeSweep("sc", 2, log),
    });

    await Promise.all([bg, scoped]);

    // Both scoped batches land before the background run takes another.
    const lastScoped = log.lastIndexOf("sc1");
    expect(lastScoped).toBeGreaterThan(-1);
    const bgAfter = log.slice(lastScoped).filter((e) => e.startsWith("bg"));
    expect(bgAfter.length).toBeGreaterThan(0);
    // ...and it DID park and come back, rather than never noticing.
    expect(paused).toEqual(["pause", "resume"]);
  });

  it("never interrupts a batch — the park happens at the checkpoint", async () => {
    // The property that makes preemption cheap: the worst case is one batch,
    // and nothing half-done is thrown away.
    const s = new Scheduler();
    const events = [];
    const bg = s.submit({
      priority: PRIORITY.BACKGROUND,
      body: async ({ checkpoint }) => {
        for (let i = 0; i < 3; i++) {
          await checkpoint();
          events.push(`begin${i}`);
          await settle();
          events.push(`commit${i}`);
        }
      },
    });
    await settle();
    const scoped = s.submit({
      priority: PRIORITY.SCOPED,
      body: async ({ checkpoint }) => {
        await checkpoint();
        events.push("scoped");
      },
    });
    await Promise.all([bg, scoped]);

    // What the design actually promises: no NEW batch starts once a scoped run
    // is outstanding. It does NOT promise the scoped body waits for the
    // in-flight batch to commit — the opposite, in fact: starting the user's
    // work as soon as possible is the point. So the assertion is about `begin`,
    // not about interleaving.
    const scopedAt = events.indexOf("scoped");
    const beginsBefore = events
      .slice(0, scopedAt)
      .filter((e) => e.startsWith("begin")).length;
    const beginsAfter = events
      .slice(scopedAt)
      .filter((e) => e.startsWith("begin")).length;
    expect(beginsBefore).toBe(1); // only the one already in flight
    expect(beginsAfter).toBe(2); // the rest resume only once scoped is done

    // And every batch that began also committed: nothing was abandoned midway.
    for (let i = 0; i < 3; i++) {
      expect(events).toContain(`begin${i}`);
      expect(events.indexOf(`commit${i}`)).toBeGreaterThan(
        events.indexOf(`begin${i}`)
      );
    }
  });

  it("runs two SCOPED requests FIFO, with the sweep parked through both", async () => {
    // Equal priority does not preempt, so this behaviour is not special-cased:
    // at every checkpoint the background run still sees higher-priority work
    // outstanding, so it stays parked until both have finished.
    const s = new Scheduler();
    const log = [];
    // NOT named "bg": `startsWith("b")` would then also match it, and the
    // scoped run "b" would look like it ran five times. A naming collision in
    // a test is a wrong answer that reads like a real failure.
    const sweep = s.submit({
      priority: PRIORITY.BACKGROUND,
      body: fakeSweep("sweep", 3, log),
    });
    await settle();
    const a = s.submit({
      priority: PRIORITY.SCOPED,
      body: fakeSweep("a", 2, log),
    });
    const b = s.submit({
      priority: PRIORITY.SCOPED,
      body: fakeSweep("b", 2, log),
    });
    await Promise.all([sweep, a, b]);

    expect(log.filter((e) => e.startsWith("a")).length).toBe(2);
    expect(log.filter((e) => e.startsWith("b")).length).toBe(2);

    // The sweep gets at most its one in-flight batch before both scoped runs
    // finish, then resumes — it is not starved permanently and not woken early.
    const lastScoped = Math.max(log.lastIndexOf("a1"), log.lastIndexOf("b1"));
    const sweepBefore = log
      .slice(0, lastScoped)
      .filter((e) => e.startsWith("sweep")).length;
    const sweepAfter = log
      .slice(lastScoped)
      .filter((e) => e.startsWith("sweep")).length;
    expect(sweepBefore).toBe(1);
    expect(sweepAfter).toBe(2);
  });

  it("coalesces a duplicate BACKGROUND submission by key", async () => {
    // A second sweep with the same key would recompute an identical worklist.
    // Saying so beats silently racing the first.
    const s = new Scheduler();
    let ran = 0;
    const first = s.submit({
      priority: PRIORITY.BACKGROUND,
      key: "backlog:embed",
      body: async ({ checkpoint }) => {
        ran += 1;
        await checkpoint();
        await settle();
      },
    });
    const second = await s.submit({
      priority: PRIORITY.BACKGROUND,
      key: "backlog:embed",
      body: async () => {
        ran += 1;
      },
    });
    expect(second).toEqual({ coalesced: true });
    await first;
    expect(ran).toBe(1);
  });

  it("lets a different key through", async () => {
    const s = new Scheduler();
    const done = [];
    await Promise.all([
      s.submit({
        priority: PRIORITY.BACKGROUND,
        key: "a",
        body: async ({ checkpoint }) => {
          await checkpoint();
          done.push("a");
        },
      }),
      s.submit({
        priority: PRIORITY.BACKGROUND,
        key: "b",
        body: async ({ checkpoint }) => {
          await checkpoint();
          done.push("b");
        },
      }),
    ]);
    expect(done.sort()).toEqual(["a", "b"]);
  });

  it("releases a parked run even when the higher-priority one THROWS", async () => {
    // Otherwise one failing scoped request strands the background sweep
    // forever, parked on a run that will never finish — a hang with no error
    // anywhere, which is the worst shape a scheduler bug can take.
    const s = new Scheduler();
    let finished = false;
    const bg = s.submit({
      priority: PRIORITY.BACKGROUND,
      body: async ({ checkpoint }) => {
        for (let i = 0; i < 2; i++) {
          await checkpoint();
          await settle();
        }
        finished = true;
      },
    });
    await settle();
    const boom = s
      .submit({
        priority: PRIORITY.SCOPED,
        body: async ({ checkpoint }) => {
          await checkpoint();
          throw new Error("scoped blew up");
        },
      })
      .catch((e) => e.message);

    expect(await boom).toBe("scoped blew up");
    await bg;
    expect(finished).toBe(true);
    expect(s.liveCount).toBe(0);
  });

  it("does not park when nothing outranks it", async () => {
    const s = new Scheduler();
    const paused = [];
    await s.submit({
      priority: PRIORITY.BACKGROUND,
      onPause: () => paused.push("pause"),
      body: async ({ checkpoint }) => {
        await checkpoint();
        await checkpoint();
      },
    });
    expect(paused).toEqual([]);
    expect(s.liveCount).toBe(0);
  });
});
