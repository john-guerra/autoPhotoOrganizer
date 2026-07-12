import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  jobs,
  connectJobsStream,
  waitForJob,
  takeNewlyFinished,
  undoFailureMessage,
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
