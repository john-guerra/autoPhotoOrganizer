import { describe, it, expect } from "vitest";
import { Scheduler, PRIORITY, RESOURCE } from "./scheduler.js";

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

describe("a park says WHAT it is waiting for (#282)", () => {
  it("hands onPause the label of the run ahead", async () => {
    // Every scheduler pause read "Waiting — a scoped request is running
    // first", which tells the user the one thing they can already see (the bar
    // is not moving) and withholds the one thing they cannot: what it is
    // waiting for, and so roughly how long. An unexplained frozen bar is
    // indistinguishable from a hang (#208).
    const s = new Scheduler();
    const log = [];
    const blockedBy = [];

    const bg = s.submit({
      priority: PRIORITY.BACKGROUND,
      label: "Scanning your photos",
      onPause: (who) => blockedBy.push(who),
      body: fakeSweep("bg", 4, log),
    });
    await settle();
    await settle();
    const scoped = s.submit({
      priority: PRIORITY.SCOPED,
      label: "Finding faces in 20 photos",
      body: fakeSweep("sc", 2, log),
    });

    await Promise.all([bg, scoped]);
    expect(blockedBy).toEqual(["Finding faces in 20 photos"]);
  });

  it("says null rather than inventing a name when the blocker has none", async () => {
    // The caller renders "another request" for this. Guessing a name would be
    // worse than the generic line it replaced.
    const s = new Scheduler();
    const log = [];
    const blockedBy = [];

    const bg = s.submit({
      priority: PRIORITY.BACKGROUND,
      onPause: (who) => blockedBy.push(who),
      body: fakeSweep("bg", 4, log),
    });
    await settle();
    await settle();
    const scoped = s.submit({
      priority: PRIORITY.SCOPED,
      body: fakeSweep("sc", 2, log),
    });

    await Promise.all([bg, scoped]);
    expect(blockedBy).toEqual([null]);
  });
});

describe("a lease per resource class — the mutual exclusion (#279)", () => {
  /**
   * The scheduler's header claimed "exactly one runnable at a time" long
   * before anything enforced it. Priority parking only ever parked a run of
   * STRICTLY LOWER priority, so two runs of EQUAL priority both proceeded.
   * Six `inFlight` booleans in api.js were doing the real work, each refusing
   * its own route with a 409 — which is why asking for two things told you no
   * instead of queueing the second.
   */
  it("keeps two same-resource runs of EQUAL priority from interleaving", async () => {
    const s = new Scheduler();
    const log = [];
    await Promise.all([
      s.submit({
        priority: PRIORITY.BACKGROUND,
        resource: RESOURCE.DB_WRITE,
        label: "Hashing",
        body: fakeSweep("a", 3, log),
      }),
      s.submit({
        priority: PRIORITY.BACKGROUND,
        resource: RESOURCE.DB_WRITE,
        label: "Enriching",
        body: fakeSweep("b", 3, log),
      }),
    ]);

    // Every batch of one, then every batch of the other. Interleaving is what
    // this test exists to forbid.
    const firstOwner = log[0][0];
    const boundary = log.findIndex((e) => e[0] !== firstOwner);
    expect(boundary).toBeGreaterThan(0);
    expect(log.slice(0, boundary).every((e) => e[0] === firstOwner)).toBe(true);
    expect(log.slice(boundary).every((e) => e[0] !== firstOwner)).toBe(true);
    expect(log).toHaveLength(6);
  });

  it("lets DIFFERENT resource classes overlap, which is the point of classes", async () => {
    // One global mutex would serialise these for nothing: hashing is IO and
    // SHA-1, a face scan is a separate process. Forcing them to alternate
    // would halve throughput and buy no latency.
    const s = new Scheduler();
    const log = [];
    await Promise.all([
      s.submit({
        priority: PRIORITY.BACKGROUND,
        resource: RESOURCE.DB_WRITE,
        body: fakeSweep("db", 3, log),
      }),
      s.submit({
        priority: PRIORITY.BACKGROUND,
        resource: RESOURCE.ONNX,
        body: fakeSweep("ml", 3, log),
      }),
    ]);
    const firstThree = log.slice(0, 3).map((e) => e.slice(0, 2));
    expect(new Set(firstThree).size).toBe(2); // genuinely interleaved
    expect(log).toHaveLength(6);
  });

  it("a run with NO resource never waits on a lease", async () => {
    const s = new Scheduler();
    const log = [];
    await Promise.all([
      s.submit({
        priority: PRIORITY.BACKGROUND,
        resource: RESOURCE.DB_WRITE,
        body: fakeSweep("held", 3, log),
      }),
      s.submit({
        priority: PRIORITY.BACKGROUND,
        body: fakeSweep("free", 3, log),
      }),
    ]);
    expect(new Set(log.slice(0, 3).map((e) => e.slice(0, 4))).size).toBe(2);
  });

  it("RELEASES the lease while parked, or a parked writer deadlocks the rest", async () => {
    // The failure this forbids: a BACKGROUND run holding `db-write` parks for
    // a SCOPED run that also needs `db-write`. If parking kept the lease, the
    // scoped run waits on the background run, which waits on the scoped run —
    // and both hang with no error anywhere.
    const s = new Scheduler();
    const log = [];
    const bg = s.submit({
      priority: PRIORITY.BACKGROUND,
      resource: RESOURCE.DB_WRITE,
      label: "Hashing",
      body: fakeSweep("bg", 4, log),
    });
    await settle();
    await settle();
    const scoped = s.submit({
      priority: PRIORITY.SCOPED,
      resource: RESOURCE.DB_WRITE,
      label: "Your folder",
      body: fakeSweep("sc", 2, log),
    });

    // The real assertion is that this resolves at all.
    await Promise.all([bg, scoped]);
    expect(log.filter((e) => e.startsWith("sc"))).toHaveLength(2);
    expect(log.filter((e) => e.startsWith("bg"))).toHaveLength(4);
    // ...and the scoped run got in before the background one finished.
    expect(log.lastIndexOf("sc1")).toBeLessThan(log.lastIndexOf("bg3"));
  });

  it("frees the lease when a run THROWS, not just when it returns", async () => {
    // A leaked lease is permanent: every later run of that class waits on a
    // holder that no longer exists, and the app quietly stops hashing forever.
    const s = new Scheduler();
    await expect(
      s.submit({
        priority: PRIORITY.BACKGROUND,
        resource: RESOURCE.DB_WRITE,
        body: async ({ checkpoint }) => {
          await checkpoint();
          throw new Error("boom");
        },
      })
    ).rejects.toThrow("boom");

    const log = [];
    await s.submit({
      priority: PRIORITY.BACKGROUND,
      resource: RESOURCE.DB_WRITE,
      body: fakeSweep("after", 2, log),
    });
    expect(log).toEqual(["after0", "after1"]);
  });
});
