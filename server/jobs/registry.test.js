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

  describe("self-clearing jobs", () => {
    /** Collect every snapshot the registry emits while `fn` runs. */
    function snapshotsDuring(fn) {
      const seen = [];
      const onChange = (jobs) => seen.push(jobs);
      registry.on("change", onChange);
      try {
        fn();
      } finally {
        registry.off("change", onChange);
      }
      return seen;
    }

    it("a finished transcode takes its own row away", () => {
      const job = registry.create("transcode", {
        label: "Converting clip.MOV",
      });
      registry.finish(job.id, { url: "/api/video/1/file" });
      expect(registry.list().find((j) => j.id === job.id)).toBeUndefined();
    });

    it("but it is SEEN as done first — a client waiting on it must not hang", () => {
      // The bug this exists to prevent: the loupe awaits the transcode job by
      // watching for it to leave "running". Delete the row on completion without
      // announcing the completion, and the video it just converted never plays —
      // the spinner spins forever. The done snapshot must go out BEFORE the row
      // disappears.
      const job = registry.create("transcode", {
        label: "Converting clip.MOV",
      });
      const snapshots = snapshotsDuring(() =>
        registry.finish(job.id, { url: "/api/video/7/file" })
      );

      const sawDone = snapshots.some((list) => {
        const j = list.find((x) => x.id === job.id);
        return j?.status === "done" && j.result?.url === "/api/video/7/file";
      });
      expect(sawDone).toBe(true);

      // ...and by the last snapshot it is gone.
      const last = snapshots.at(-1);
      expect(last.find((j) => j.id === job.id)).toBeUndefined();
    });

    it("stays answerable by id after it clears, so a POLLING caller still sees it finish", () => {
      // The other half of the same hazard. A job that removes itself the instant
      // it succeeds is invisible to anyone who SAMPLES the registry instead of
      // subscribing: the done state can land entirely between two polls, so the
      // job goes straight from "running" to "gone" and the caller waits forever.
      // It leaves the LIST (which is what the UI draws); it does not leave the
      // registry.
      const job = registry.create("enrich", { label: "Read metadata" });
      registry.finish(job.id, { read: 12, failed: 0 });

      expect(registry.list().find((j) => j.id === job.id)).toBeUndefined();
      const found = registry.get(job.id);
      expect(found?.status).toBe("done");
      expect(found.result).toEqual({ read: 12, failed: 0 });
    });

    it("a FAILED transcode stays — a failure is news, and waits for a human", () => {
      const job = registry.create("transcode", {
        label: "Converting clip.MOV",
      });
      registry.fail(job.id, new Error("ffmpeg exploded"));
      const entry = registry.list().find((j) => j.id === job.id);
      expect(entry?.status).toBe("failed");
      expect(entry.error).toContain("ffmpeg exploded");
    });

    it("a finished scan stays — its result is the whole point", () => {
      const job = registry.create("scan", { label: "Scan /cards" });
      registry.finish(job.id, { folders: 2, count: 300 });
      expect(registry.list().find((j) => j.id === job.id)?.status).toBe("done");
    });
  });

  describe("dismissAll()", () => {
    it("drops the finished jobs, keeps the running one, and says how many went", () => {
      const running = registry.create("scan", { label: "Scanning…" });
      const done = registry.create("export", { label: "Export" });
      const failed = registry.create("export", { label: "Export 2" });
      registry.finish(done.id, { copied: 3 });
      registry.fail(failed.id, new Error("disk full"));

      expect(registry.dismissAll()).toBeGreaterThanOrEqual(2);

      const ids = registry.list().map((j) => j.id);
      expect(ids).toContain(running.id);
      expect(ids).not.toContain(done.id);
      expect(ids).not.toContain(failed.id);

      registry.cancel(running.id);
      registry.fail(running.id, new Error("canceled"));
      registry.dismissAll();
    });

    it("emits nothing when there is nothing to dismiss", () => {
      registry.dismissAll();
      const running = registry.create("scan", { label: "Scanning…" });
      let emits = 0;
      const onChange = () => (emits += 1);
      registry.on("change", onChange);
      try {
        expect(registry.dismissAll()).toBe(0);
      } finally {
        registry.off("change", onChange);
      }
      expect(emits).toBe(0);

      registry.cancel(running.id);
      registry.fail(running.id, new Error("canceled"));
      registry.dismissAll();
    });
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
