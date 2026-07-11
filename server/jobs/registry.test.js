import { describe, it, expect } from "vitest";
import { registry } from "./registry.js";

describe("JobRegistry", () => {
  it("create() returns a running job with a fresh AbortController", () => {
    const job = registry.create("scan", { label: "Scan foo", total: 10 });
    expect(job.status).toBe("running");
    expect(job.type).toBe("scan");
    expect(job.label).toBe("Scan foo");
    expect(job.total).toBe(10);
    expect(job.done).toBe(0);
    expect(job.controller).toBeInstanceOf(AbortController);
    expect(job.controller.signal.aborted).toBe(false);
  });

  it("create() assigns monotonically increasing ids", () => {
    const a = registry.create("scan", { label: "a" });
    const b = registry.create("scan", { label: "b" });
    expect(a.id).not.toBe(b.id);
    const numA = Number(a.id.replace("job-", ""));
    const numB = Number(b.id.replace("job-", ""));
    expect(numB).toBeGreaterThan(numA);
  });

  it("create() emits a 'change' event with the job list", () => {
    const events = [];
    const onChange = (jobs) => events.push(jobs);
    registry.on("change", onChange);
    try {
      const job = registry.create("export", { label: "Export" });
      expect(events.length).toBeGreaterThan(0);
      const last = events[events.length - 1];
      expect(last.some((j) => j.id === job.id)).toBe(true);
    } finally {
      registry.off("change", onChange);
    }
  });

  it("update() merges done/total/phase and emits 'change'", () => {
    const job = registry.create("export", { label: "Export", total: 5 });
    const events = [];
    const onChange = (jobs) => events.push(jobs);
    registry.on("change", onChange);
    try {
      registry.update(job.id, { done: 2, total: 5, phase: "copying" });
      const updated = registry.get(job.id);
      expect(updated.done).toBe(2);
      expect(updated.total).toBe(5);
      expect(updated.phase).toBe("copying");
      expect(updated.status).toBe("running");
      expect(events.length).toBeGreaterThan(0);
    } finally {
      registry.off("change", onChange);
    }
  });

  it("update() on an unknown id is a no-op (no throw)", () => {
    expect(() =>
      registry.update("job-does-not-exist", { done: 1 })
    ).not.toThrow();
  });

  it("finish() sets terminal status 'done', stores result, and emits", () => {
    const job = registry.create("export", { label: "Export" });
    const events = [];
    const onChange = (jobs) => events.push(jobs);
    registry.on("change", onChange);
    try {
      registry.finish(job.id, { copied: 3 });
      const done = registry.get(job.id);
      expect(done.status).toBe("done");
      expect(done.result).toEqual({ copied: 3 });
      expect(events.length).toBeGreaterThan(0);
    } finally {
      registry.off("change", onChange);
    }
  });

  it("fail() sets status 'failed' and stores the error message when not aborted", () => {
    const job = registry.create("export", { label: "Export" });
    registry.fail(job.id, new Error("boom"));
    const failed = registry.get(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("boom");
  });

  it("fail() sets status 'canceled' when the job's signal was aborted", () => {
    const job = registry.create("export", { label: "Export" });
    job.controller.abort();
    registry.fail(job.id, new Error("canceled"));
    const failed = registry.get(job.id);
    expect(failed.status).toBe("canceled");
  });

  it("cancel() aborts the controller; the running op later reports 'canceled' via fail()", () => {
    const job = registry.create("export", { label: "Export" });
    const ok = registry.cancel(job.id);
    expect(ok).toBe(true);
    expect(job.controller.signal.aborted).toBe(true);
    // cancel() only signals abort; the terminal status is set once the
    // aborted operation's catch reports back via fail().
    registry.fail(job.id, new Error("canceled"));
    expect(registry.get(job.id).status).toBe("canceled");
  });

  it("cancel() returns false for an unknown id or a non-running job", () => {
    expect(registry.cancel("job-does-not-exist")).toBe(false);
    const job = registry.create("export", { label: "Export" });
    registry.finish(job.id, {});
    expect(registry.cancel(job.id)).toBe(false);
  });

  it("dismiss() removes a terminal job", () => {
    const job = registry.create("export", { label: "Export" });
    registry.finish(job.id, {});
    const ok = registry.dismiss(job.id);
    expect(ok).toBe(true);
    expect(registry.get(job.id)).toBeUndefined();
  });

  it("dismiss() refuses a running job", () => {
    const job = registry.create("export", { label: "Export" });
    const ok = registry.dismiss(job.id);
    expect(ok).toBe(false);
    expect(registry.get(job.id)).toBeDefined();
  });

  it("list() omits the controller field", () => {
    const job = registry.create("export", { label: "Export" });
    const list = registry.list();
    const entry = list.find((j) => j.id === job.id);
    expect(entry).toBeDefined();
    expect(entry.controller).toBeUndefined();
  });

  it("list() is a snapshot: mutating the returned array/objects doesn't affect internal state", () => {
    const job = registry.create("export", { label: "Export", total: 1 });
    const list = registry.list();
    const entry = list.find((j) => j.id === job.id);
    entry.done = 999;
    list.push({ id: "job-fake", status: "running" });
    const fresh = registry.list();
    expect(fresh.find((j) => j.id === job.id).done).not.toBe(999);
    expect(fresh.find((j) => j.id === "job-fake")).toBeUndefined();
  });
});
