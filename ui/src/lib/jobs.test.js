import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  jobs,
  connectJobsStream,
  waitForJob,
  takeNewlyFinished,
  undoFailureMessage,
  crossedStep,
} from "./jobs.js";

/** Minimal fake EventSource — enough for the store reducer + waitForJob. */
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    FakeEventSource.last = this;
  }
  emit(data) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

beforeAll(() => {
  // vitest runs in a "node" environment (no global EventSource), so the
  // module's own auto-connect is a no-op; wire the fake in explicitly.
  connectJobsStream(FakeEventSource);
});

beforeEach(() => {
  jobs.set([]);
});

describe("jobs store", () => {
  it("holds the latest SSE snapshot", () => {
    FakeEventSource.last.emit([{ id: "job-1", status: "running" }]);
    expect(get(jobs)).toEqual([{ id: "job-1", status: "running" }]);

    FakeEventSource.last.emit([
      { id: "job-1", status: "done" },
      { id: "job-2", status: "running" },
    ]);
    expect(get(jobs)).toHaveLength(2);
    expect(get(jobs)[0].status).toBe("done");
  });

  it("connectJobsStream opens only one connection", () => {
    const before = FakeEventSource.last;
    connectJobsStream(FakeEventSource);
    expect(FakeEventSource.last).toBe(before);
  });
});

describe("waitForJob", () => {
  it("resolves once the matching job's status leaves running", async () => {
    FakeEventSource.last.emit([{ id: "job-1", status: "running" }]);
    const promise = waitForJob("job-1");
    let resolved = false;
    promise.then(() => (resolved = true));

    await Promise.resolve();
    expect(resolved).toBe(false);

    FakeEventSource.last.emit([
      { id: "job-1", status: "done", result: { copied: 3 } },
    ]);
    const job = await promise;
    expect(job.status).toBe("done");
    expect(job.result.copied).toBe(3);
  });

  it("does NOT resolve when a job PAUSES (#260)", async () => {
    // The latent half of #260, and the worse half. waitForJob resolved on any
    // status other than "running", so the moment a job parked every waiter
    // would behave as though the work had FINISHED — including the
    // progressive-render path this function exists for, which would stop
    // filling the grid while the scan is merely waiting for a drive.
    FakeEventSource.last.emit([{ id: "job-p", status: "running" }]);
    const progress = [];
    const promise = waitForJob("job-p", (j) => progress.push(j.status));
    let resolved = false;
    promise.then(() => (resolved = true));

    FakeEventSource.last.emit([
      { id: "job-p", status: "paused", pauseReason: "Drive not available" },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    // ...and a pause is reported as progress, so a caller can say why it is
    // waiting rather than sitting on a silent spinner.
    expect(progress).toContain("paused");

    // Resuming and finishing still resolves normally.
    FakeEventSource.last.emit([{ id: "job-p", status: "done", result: {} }]);
    const job = await promise;
    expect(job.status).toBe("done");
  });

  it("resolves immediately when the job is already terminal", async () => {
    FakeEventSource.last.emit([
      { id: "job-2", status: "failed", error: "boom" },
    ]);
    const job = await waitForJob("job-2");
    expect(job.status).toBe("failed");
    expect(job.error).toBe("boom");
  });

  it("unsubscribes after resolving (no error on further emits)", async () => {
    FakeEventSource.last.emit([{ id: "job-5", status: "running" }]);
    const promise = waitForJob("job-5");
    FakeEventSource.last.emit([{ id: "job-5", status: "canceled" }]);
    const job = await promise;
    expect(job.status).toBe("canceled");

    expect(() =>
      FakeEventSource.last.emit([
        { id: "job-5", status: "canceled" },
        { id: "job-6", status: "running" },
      ])
    ).not.toThrow();
    expect(get(jobs)).toHaveLength(2);
  });
});

describe("takeNewlyFinished", () => {
  it("returns a job that just reached a terminal state, once", () => {
    const handled = new Set();
    const list = [{ id: "u1", type: "undo-move", status: "done" }];
    expect(
      takeNewlyFinished(list, "undo-move", handled).map((j) => j.id)
    ).toEqual(["u1"]);
    // A second snapshot with the same terminal job must not re-fire.
    expect(takeNewlyFinished(list, "undo-move", handled)).toEqual([]);
  });

  it("ignores still-running jobs until they finish", () => {
    const handled = new Set();
    const running = [{ id: "u1", type: "undo-move", status: "running" }];
    expect(takeNewlyFinished(running, "undo-move", handled)).toEqual([]);
    const done = [{ id: "u1", type: "undo-move", status: "done" }];
    expect(
      takeNewlyFinished(done, "undo-move", handled).map((j) => j.id)
    ).toEqual(["u1"]);
  });

  it("ignores jobs of a different type", () => {
    const handled = new Set();
    const list = [{ id: "m1", type: "materialize", status: "done" }];
    expect(takeNewlyFinished(list, "undo-move", handled)).toEqual([]);
  });

  it("fires for canceled and failed terminals too (partial restores leave stale UI)", () => {
    const handled = new Set();
    const list = [
      { id: "u1", type: "undo-move", status: "canceled" },
      { id: "u2", type: "undo-move", status: "failed" },
    ];
    expect(
      takeNewlyFinished(list, "undo-move", handled).map((j) => j.id)
    ).toEqual(["u1", "u2"]);
  });
});

describe("undoFailureMessage", () => {
  it("gives a size-specific, actionable message for a 413", () => {
    const err = Object.assign(new Error("undo failed (413)"), { status: 413 });
    const msg = undoFailureMessage(err, 4200);
    expect(msg).toContain("too large to send");
    expect(msg).toContain("4200 files");
    expect(msg).toContain("retry from the jobs panel");
  });

  it("falls back to the thrown error's message for other failures", () => {
    const err = new Error("network down");
    const msg = undoFailureMessage(err, 3);
    expect(msg).toContain("network down");
    expect(msg).toContain("retry from the jobs panel");
  });

  it("never produces 'undefined' when the error has no message", () => {
    expect(undoFailureMessage(undefined, 1)).not.toMatch(/undefined/);
  });
});

describe("crossedStep", () => {
  // The gate that lets the grid fill in WHILE a scan is still walking the disk,
  // instead of staying empty until the whole job finishes. It fires once per
  // `step` photos, so a 100k-photo scan costs ~500 refreshes, not 100,000.
  it("fires once when the count crosses a multiple of the step", () => {
    expect(crossedStep(0, 199, 200)).toBe(false);
    expect(crossedStep(0, 200, 200)).toBe(true);
    expect(crossedStep(200, 399, 200)).toBe(false);
    expect(crossedStep(200, 400, 200)).toBe(true);
  });

  it("fires only once per step, however many ticks land inside it", () => {
    // Progress ticks arrive per FILE. Without the floor-division the refresh
    // would fire on every tick past the first threshold — a feed page per photo.
    let last = 0;
    let refreshes = 0;
    for (let done = 1; done <= 1000; done++) {
      if (crossedStep(last, done, 200)) {
        refreshes++;
        last = done;
      }
    }
    expect(refreshes).toBe(5); // 200, 400, 600, 800, 1000 — not 1000
  });

  it("never fires before the first photo is indexed", () => {
    // A refresh at done=0 would just re-read an empty feed.
    expect(crossedStep(0, 0, 200)).toBe(false);
    expect(crossedStep(0, undefined, 200)).toBe(false);
    expect(crossedStep(0, NaN, 200)).toBe(false);
  });

  it("survives a job that jumps several steps between snapshots", () => {
    // SSE snapshots coalesce: done can leap 0 -> 1000 in one tick.
    expect(crossedStep(0, 1000, 200)).toBe(true);
  });
});

describe("waitForJob — progress", () => {
  it("reports every running snapshot, then resolves on the terminal one", async () => {
    const seen = [];
    jobs.set([{ id: "s1", type: "scan", status: "running", done: 0 }]);
    const settled = waitForJob("s1", (j) => seen.push(j.done));

    jobs.set([{ id: "s1", type: "scan", status: "running", done: 200 }]);
    jobs.set([{ id: "s1", type: "scan", status: "running", done: 400 }]);
    jobs.set([{ id: "s1", type: "scan", status: "done", done: 500 }]);

    const job = await settled;
    expect(job.status).toBe("done");
    // The whole point: the client HEARS the scan progressing. It used to await
    // the end of the job and throw every one of these away.
    expect(seen).toEqual([0, 200, 400]);
  });

  it("still resolves for a caller that passes no progress callback", async () => {
    jobs.set([{ id: "s2", type: "scan", status: "running", done: 1 }]);
    const settled = waitForJob("s2");
    jobs.set([{ id: "s2", type: "scan", status: "done", done: 9 }]);
    expect((await settled).status).toBe("done");
  });
});
