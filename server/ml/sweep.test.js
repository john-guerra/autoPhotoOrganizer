import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSweep } from "./sweep.js";

const noIdle = () => Promise.resolve();
/** A job whose signal is never aborted. */
const liveJob = () => ({ controller: new AbortController() });

/** Drains `rows` in pages of `size`, honouring whatever `process` removed. */
function makeWorklist(rows, size = 2) {
  const pending = new Map(rows.map((r) => [r.id, r]));
  return {
    pending,
    nextBatch: () => [...pending.values()].slice(0, size),
  };
}

describe("runSweep", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sweep-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("drains the worklist to empty", async () => {
    const rows = [1, 2, 3, 4, 5].map((id) => ({ id, folder: dir }));
    const wl = makeWorklist(rows);
    const result = await runSweep(liveJob(), {
      nextBatch: wl.nextBatch,
      process: async (batch) => {
        for (const r of batch) wl.pending.delete(r.id);
        return batch.length;
      },
      markFailed: () => {},
      folderOf: (r) => r.folder,
      idle: noIdle,
    });
    expect(result).toEqual({ done: 5, failed: 0, paused: false });
    expect(wl.pending.size).toBe(0);
  });

  it("isolates a poison row: batch fails, the rest still land, loop drains", async () => {
    const rows = [1, 2, 3, 4].map((id) => ({ id, folder: dir }));
    const wl = makeWorklist(rows);
    const failed = [];
    const result = await runSweep(liveJob(), {
      nextBatch: wl.nextBatch,
      process: async (batch) => {
        // Row 3 poisons any batch it is in — the shape of a real extractor that
        // throws on one bad file and takes its whole batch down with it.
        if (batch.some((r) => r.id === 3)) throw new Error("bad file");
        for (const r of batch) wl.pending.delete(r.id);
        return batch.length;
      },
      markFailed: (row) => {
        failed.push(row.id);
        wl.pending.delete(row.id); // the sentinel write removes it from the worklist
      },
      folderOf: (r) => r.folder,
      idle: noIdle,
    });
    expect(failed).toEqual([3]);
    expect(result.done).toBe(4); // 3 written + 1 sentinel
    expect(result.failed).toBe(1);
    expect(wl.pending.size).toBe(0);
  });

  it("PAUSES and marks NOTHING when the folder is unreachable (#169)", async () => {
    // This is the regression test for #169. The old hand-rolled hasher marked
    // every unreachable row hash_attempted=1, and upsertScan only clears that
    // when size/mtime CHANGE — which an unmount does not. The rows became
    // permanently invisible to the sweep.
    const gone = join(dir, "unmounted");
    const rows = [1, 2, 3].map((id) => ({ id, folder: gone }));
    const wl = makeWorklist(rows);
    const failed = [];
    const result = await runSweep(liveJob(), {
      nextBatch: wl.nextBatch,
      process: async () => {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      },
      markFailed: (row) => failed.push(row.id),
      folderOf: (r) => r.folder,
      idle: noIdle,
    });
    expect(failed).toEqual([]); // nothing marked — the whole point
    expect(result.paused).toBe(true);
    expect(result.failed).toBe(0);
    expect(wl.pending.size).toBe(3); // still owed work, for the next pass
  });

  it("marks permanently when the folder IS reachable but the file is not", async () => {
    const rows = [{ id: 1, folder: dir }];
    const wl = makeWorklist(rows);
    const failed = [];
    const result = await runSweep(liveJob(), {
      nextBatch: wl.nextBatch,
      process: async () => {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      },
      markFailed: (row) => {
        failed.push(row.id);
        wl.pending.delete(row.id);
      },
      folderOf: (r) => r.folder,
      idle: noIdle,
    });
    expect(failed).toEqual([1]);
    expect(result.paused).toBe(false);
    expect(result.failed).toBe(1);
  });

  it("PAUSES and marks NOTHING on a transient error code even with a REACHABLE folder", async () => {
    // Same #169 failure shape through a different trigger: an EMFILE storm (or
    // EIO/EBUSY/etc on a flaky external/network volume) is a property of the
    // MOMENT, not the file. The folder is present the whole time — only the
    // error code says "transient" — so this must pause, not markFailed, or
    // those rows get the same permanent sentinel #169 shipped.
    const rows = [1, 2, 3].map((id) => ({ id, folder: dir }));
    const wl = makeWorklist(rows);
    const failed = [];
    const result = await runSweep(liveJob(), {
      nextBatch: wl.nextBatch,
      process: async () => {
        const e = new Error("EMFILE, too many open files");
        e.code = "EMFILE";
        throw e;
      },
      markFailed: (row) => failed.push(row.id),
      folderOf: (r) => r.folder,
      idle: noIdle,
    });
    expect(failed).toEqual([]); // nothing marked — the whole point
    expect(result.paused).toBe(true);
    expect(result.failed).toBe(0);
    expect(wl.pending.size).toBe(3); // still owed work, for the next pass
  });

  it("still marks permanently for ENOENT with a reachable folder (no regression)", async () => {
    // Companion to the transient-code test above: ENOENT with the folder
    // present means the file itself is really gone, which IS a permanent
    // property of the photo — the existing, documented behaviour must not
    // regress when the transient-code classification is introduced.
    const rows = [{ id: 1, folder: dir }];
    const wl = makeWorklist(rows);
    const failed = [];
    const result = await runSweep(liveJob(), {
      nextBatch: wl.nextBatch,
      process: async () => {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      },
      markFailed: (row) => {
        failed.push(row.id);
        wl.pending.delete(row.id);
      },
      folderOf: (r) => r.folder,
      idle: noIdle,
    });
    expect(failed).toEqual([1]);
    expect(result.paused).toBe(false);
    expect(result.failed).toBe(1);
  });

  it("throws AbortError when the job is canceled, without marking", async () => {
    const rows = [1, 2, 3, 4].map((id) => ({ id, folder: dir }));
    const wl = makeWorklist(rows);
    const job = liveJob();
    const failed = [];
    await expect(
      runSweep(job, {
        nextBatch: wl.nextBatch,
        process: async (batch) => {
          job.controller.abort(); // cancel arrives mid-flight
          for (const r of batch) wl.pending.delete(r.id);
          return batch.length;
        },
        markFailed: (row) => failed.push(row.id),
        folderOf: (r) => r.folder,
        idle: noIdle,
      })
    ).rejects.toThrow(/canceled/i);
    expect(failed).toEqual([]);
    expect(wl.pending.size).toBeGreaterThan(0);
  });

  it("does not mark a sentinel when cancel arrives mid-flight during the per-row retry", async () => {
    // Regression for the race the original cancel test didn't cover: that test
    // aborts inside a SUCCEEDING process() call, so it never exercises the
    // path where the call that was in flight when cancel fired goes on to
    // REJECT with an ordinary (non-Abort) error. Without a re-check right
    // after that rejection, the code fell through to markFailed and wrote a
    // sentinel after the user had already asked to stop.
    const rows = [1, 2].map((id) => ({ id, folder: dir }));
    const wl = makeWorklist(rows, 2);
    const job = liveJob();
    const failed = [];
    await expect(
      runSweep(job, {
        nextBatch: wl.nextBatch,
        process: async (batch) => {
          if (batch.length > 1) throw new Error("poison batch"); // force per-row retry
          // Per-row retry: cancel arrives WHILE this call is in flight, and
          // the call itself then rejects with an ordinary error — not an
          // AbortError.
          job.controller.abort();
          throw new Error("boom");
        },
        markFailed: (row) => failed.push(row.id),
        folderOf: (r) => r.folder,
        idle: noIdle,
      })
    ).rejects.toThrow(/canceled/i);
    expect(failed).toEqual([]);
  });

  it("throws rather than hanging when markFailed does not remove the row from the worklist", async () => {
    // Regression: nextBatch() is re-queried every pass with no visited-set —
    // the loop only terminates because markFailed is expected to remove its
    // row from whatever nextBatch reads. A caller that forgets to do that
    // must get a loud, named error, not an infinite loop with no error
    // anywhere ("nothing fails silently").
    //
    // nextBatch here returns a FRESH object with the same id on every call —
    // this mimics what better-sqlite3's `.all()` actually does (a new row
    // object per query, never the same reference), and both real callers of
    // runSweep are SQL-backed. A guard built on object-reference identity
    // would never fire against this shape: it only protects an in-memory
    // test worklist, not the real one. Identity has to be by id.
    const failed = [];
    await expect(
      runSweep(liveJob(), {
        nextBatch: () => [{ id: 1, folder: dir }], // new object, same id, every call
        process: async () => {
          const e = new Error("ENOENT");
          e.code = "ENOENT";
          throw e;
        },
        markFailed: (row) => failed.push(row.id), // caller bug: never removes the row
        folderOf: (r) => r.folder,
        idle: noIdle,
      })
    ).rejects.toThrow(/markFailed must remove the row/i);
    expect(failed).toEqual([1]);
  }, 2000);

  it("reports progress after each batch", async () => {
    const rows = [1, 2, 3, 4].map((id) => ({ id, folder: dir }));
    const wl = makeWorklist(rows);
    const seen = [];
    await runSweep(liveJob(), {
      nextBatch: wl.nextBatch,
      process: async (batch) => {
        for (const r of batch) wl.pending.delete(r.id);
        return batch.length;
      },
      markFailed: () => {},
      folderOf: (r) => r.folder,
      onProgress: (p) => seen.push(p.done),
      idle: noIdle,
    });
    expect(seen).toEqual([2, 4]);
  });

  it("stands aside for the user between batches", async () => {
    const rows = [1, 2, 3, 4].map((id) => ({ id, folder: dir }));
    const wl = makeWorklist(rows);
    const idle = vi.fn(() => Promise.resolve());
    await runSweep(liveJob(), {
      nextBatch: wl.nextBatch,
      process: async (batch) => {
        for (const r of batch) wl.pending.delete(r.id);
        return batch.length;
      },
      markFailed: () => {},
      folderOf: (r) => r.folder,
      idle,
    });
    // Two full batches plus the final empty check.
    expect(idle).toHaveBeenCalledTimes(3);
  });

  it("runs with a null job (uncancelable background sweep)", async () => {
    const rows = [{ id: 1, folder: dir }];
    const wl = makeWorklist(rows);
    const result = await runSweep(null, {
      nextBatch: wl.nextBatch,
      process: async (batch) => {
        for (const r of batch) wl.pending.delete(r.id);
        return batch.length;
      },
      markFailed: () => {},
      folderOf: (r) => r.folder,
      idle: noIdle,
    });
    expect(result.done).toBe(1);
  });
});
