import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { get } from "svelte/store";
import { jobs, connectJobsStream, waitForJob } from "./jobs.js";

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
