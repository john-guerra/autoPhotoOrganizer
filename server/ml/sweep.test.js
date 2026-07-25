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
