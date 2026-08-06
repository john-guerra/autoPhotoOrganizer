# ML Sidecar Foundation + Generalized Idle Sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract one shared background-sweep loop, migrate both existing sweeps onto it (fixing #169 en route), and stand up the out-of-process ML sidecar with its packaging — no model, no inference.

**Architecture:** `runSweep` owns the drain loop, idle gating, cancellation, poison-file isolation, and — the load-bearing part — the _classification_ of a failure as permanent (the photo's fault) or transient (the drive went away). Each caller keeps owning its own sentinel _write_, because the three sentinels are genuinely different shapes. `server/ml/` mirrors `server/processing/`: an abstract `MLService`, an `OnnxMLService` that spawns and supervises a child, and a worker that answers exactly one op.

**Tech Stack:** Node 24 ESM, better-sqlite3, vitest, Express, Svelte 4, electron-builder, onnxruntime-node.

**Spec:** `docs/superpowers/specs/2026-07-25-ml-sidecar-and-sweep-design.md`

## Global Constraints

- **ESM everywhere** (`"type": "module"`). No TypeScript — plain JS with JSDoc types.
- **Tests are vitest, colocated** as `*.test.js` next to the source under `server/`.
- **Prettier** formats everything: `npm run format` before each commit.
- **Version bump in the same commit as the change.** Final version for this plan: `2.18.5` (patch). Bump once, in Task 9, with the `CHANGELOG.md` entry.
- **A fixed bug gets a test that would have caught it.** Before committing a fix, revert the fix and watch the test go red, then restore. A test that never failed proves nothing.
- **Never fail silently** — every user-triggerable failure is visible, specific, and actionable in the UI.
- **The default test suite must never spawn a child process or download a model.** The single test that spawns the real child is gated behind `ML_INTEGRATION=1`.
- **Do not modify anything inside the user's real photo folders.** Tests use `mkdtempSync` under `tmpdir()`.
- Run the full suite with `npm test`. A single file: `npx vitest run server/ml/sweep.test.js`.

---

### Task 1: `reachable()` — the volume probe

The one new primitive #169 needs: can we still see the folder this row lives in?

**Files:**

- Create: `server/lib/reachable.js`
- Test: `server/lib/reachable.test.js`

**Interfaces:**

- Consumes: nothing.
- Produces: `reachable(absPath: string) => boolean` — synchronous, `true` when `absPath` is an existing directory.

- [ ] **Step 1: Write the failing test**

```js
// server/lib/reachable.test.js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reachable } from "./reachable.js";

describe("reachable", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reachable-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is true for a directory that exists", () => {
    expect(reachable(dir)).toBe(true);
  });

  it("is false for a directory that does not exist", () => {
    expect(reachable(join(dir, "gone"))).toBe(false);
  });

  it("is false for a path that exists but is a FILE, not a directory", () => {
    // A folder row's abs_path must be a directory. If a file sits at that path
    // the index is wrong about the world, and treating it as reachable would
    // let the sweep mark every row in it permanently failed.
    const f = join(dir, "not-a-dir");
    writeFileSync(f, "x");
    expect(reachable(f)).toBe(false);
  });

  it("is false rather than throwing for a nonsense path", () => {
    expect(reachable("\0invalid")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/lib/reachable.test.js`
Expected: FAIL — `Failed to resolve import "./reachable.js"`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/lib/reachable.js
import { statSync } from "node:fs";

/**
 * Is this folder still there?
 *
 * The sweep's failure classifier needs to tell "this photo is corrupt" from
 * "the drive went away" — see #169, where conflating the two marked every
 * unreachable file permanently attempted and excluded it from hashing forever.
 *
 * Probes the FOLDER, deliberately:
 *  - not the file, whose absence is the thing being diagnosed;
 *  - not the volume mount root, because on macOS `/Volumes/Name` can survive an
 *    eject as an empty directory, which would report a vanished drive as
 *    present and defeat the whole check.
 *
 * Synchronous: it runs only on the failure path (one stat per FAILURE, not per
 * row), and the sweep is already awaiting between batches.
 *
 * @param {string} absPath folder path
 * @returns {boolean}
 */
export function reachable(absPath) {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/lib/reachable.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
npm run format
git add server/lib/reachable.js server/lib/reachable.test.js
git commit -m "feat(sweep): reachable() — tell a vanished drive from a bad file (#169)"
```

---

### Task 2: `runSweep` — the shared drain loop

The whole point of the slice. Written standalone and fully tested before either caller moves onto it.

**Files:**

- Create: `server/ml/sweep.js`
- Test: `server/ml/sweep.test.js`

**Interfaces:**

- Consumes: `reachable` (Task 1); `whenIdle` from `server/lib/interactive.js`.
- Produces:

```js
runSweep(job, {
  nextBatch,   // () => Row[]                  re-queried each pass
  process,     // (rows: Row[]) => Promise<number>   count written
  markFailed,  // (row: Row, err: Error) => void     caller's sentinel write
  folderOf,    // (row: Row) => string               folder abs_path
  onProgress,  // ({done, failed}) => void           optional
  idle,        // () => Promise<void>                optional, defaults whenIdle
}) => Promise<{ done: number, failed: number, paused: boolean }>
```

`job` is a registry job (`{ controller: AbortController }`) or `null` for an uncancelable sweep.

- [ ] **Step 1: Write the failing test**

```js
// server/ml/sweep.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/ml/sweep.test.js`
Expected: FAIL — `Failed to resolve import "./sweep.js"`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/ml/sweep.js
import { whenIdle } from "../lib/interactive.js";
import { reachable } from "../lib/reachable.js";

/**
 * ONE background drain, reused by every sweep in the app.
 *
 * `/api/enrich` and `hashAllPending` were the same loop written twice by hand.
 * They had already diverged (enrich had a job, progress, cancellation and
 * per-file isolation; the hasher had none) and the hand-rolled copy shipped a
 * termination bug the shared version would not have — #169. This is the same
 * consolidation CLAUDE.md describes for the feed-window guard, and for the same
 * reason: six hand-copies caused two shipped bugs.
 *
 * THE SPLIT THAT MATTERS: the caller owns the sentinel WRITE, `runSweep` owns
 * the CLASSIFICATION.
 *
 * The three sentinels in this codebase are not interchangeable and must not be
 * unified — enrich overloads data columns (width=0, lens=""), hashing uses a
 * boolean (hash_attempted=1), and a future ML stage needs an explicit row
 * because a failed embedding has no natural zero value. So the write stays a
 * callback. But "is this failure the photo's fault or the moment's?" is exactly
 * what each hand-rolled copy got to answer for itself, and it is what the
 * hasher got wrong. That answer lives here, once.
 *
 * @param {{controller: AbortController}|null} job registry job, or null
 * @param {object} opts
 * @param {() => Array<any>} opts.nextBatch rows still owed work — RE-QUERIED
 *   each pass, so the worklist is SQL and a crash costs one batch, not the backlog
 * @param {(rows: Array<any>) => Promise<number>} opts.process writes; returns count
 * @param {(row: any, err: Error) => void} opts.markFailed the sentinel write
 * @param {(row: any) => string} opts.folderOf folder abs_path, for the probe
 * @param {(p: {done: number, failed: number}) => void} [opts.onProgress]
 * @param {() => Promise<void>} [opts.idle]
 * @returns {Promise<{done: number, failed: number, paused: boolean}>}
 */
export async function runSweep(
  job,
  { nextBatch, process, markFailed, folderOf, onProgress, idle = whenIdle }
) {
  let done = 0;
  let failed = 0;

  const abortIfCanceled = () => {
    if (job?.controller.signal.aborted) {
      const e = new Error("canceled");
      e.name = "AbortError";
      throw e;
    }
  };

  for (;;) {
    abortIfCanceled();
    // Let the user go first. A full-library sweep will happily starve the
    // thumbnails the user is actually waiting on (measured: 15ms -> 90ms, tiles
    // abandoned mid-scroll). State-driven, not timer-driven — see
    // lib/interactive.js.
    await idle();
    const batch = nextBatch();
    if (!batch.length) break;

    try {
      done += await process(batch);
    } catch {
      // One unreadable file must not kill a 100k sweep. Retry one at a time so
      // the bad file is isolated and the rest of the batch still lands.
      for (const row of batch) {
        abortIfCanceled();
        try {
          done += await process([row]);
        } catch (err) {
          // THE #169 CLASSIFICATION. A missing FOLDER means the volume went
          // away, and nothing in this pass is processable — so stop, and mark
          // NOTHING. Marking here is what excluded those photos forever:
          // upsertScan only clears a sentinel when size/mtime change, and an
          // unmount changes neither. Pausing costs one resumed pass; marking
          // costs the data.
          if (!reachable(folderOf(row))) {
            onProgress?.({ done, failed });
            return { done, failed, paused: true };
          }
          // Folder is there and the file still failed: the file is genuinely
          // gone or genuinely unreadable. That IS a permanent property of the
          // photo, so the caller writes its sentinel and the row leaves the
          // worklist.
          markFailed(row, err);
          done += 1;
          failed += 1;
        }
      }
    }
    onProgress?.({ done, failed });
  }
  return { done, failed, paused: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/ml/sweep.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
npm run format
git add server/ml/sweep.js server/ml/sweep.test.js
git commit -m "feat(sweep): runSweep — one drain loop, classification shared (#160)"
```

---

### Task 3: Migrate the content hasher onto `runSweep`

Deletes the hand-rolled loop that shipped #169, and gives hashing the job/progress/cancel enrich already had.

**Files:**

- Modify: `server/db/hashing.js` (replace `hashPendingPhotos` + `hashAllPending`)
- Modify: `server/db/hashing.test.js` (per-batch cases move to `runSweep`; outcome cases stay)
- Modify: `server/api.js:631,652` (pass a job)
- Modify: `server/jobs/registry.js:3,16` (add the `hash` type)

**Interfaces:**

- Consumes: `runSweep` (Task 2).
- Produces: `hashAllPending(db, {limit?, idle?, job?}) => Promise<{hashed, failed, paused, alreadyRunning?}>`. `hashPendingPhotos` is **deleted** — its batch loop is now `runSweep`'s.

- [ ] **Step 1: Write the failing test**

Replace the `hashPendingPhotos` and `hashAllPending` describes in `server/db/hashing.test.js` with these. Keep the existing `hashFile` and `upsertScan + hashing` describes untouched.

```js
describe("hashAllPending", () => {
  it("hashes the WHOLE library across batches and TERMINATES past an unreadable file", async () => {
    _resetHashingForTest();
    const db = new Database(":memory:");
    applySchema(db);
    const dir = mkdtempSync(join(tmpdir(), "hash-all-"));
    const entries = [];
    for (let i = 0; i < 5; i++) {
      const name = `IMG_${i}.JPG`;
      writeFileSync(join(dir, name), `bytes ${i}`);
      const st = statSync(join(dir, name));
      entries.push({
        name,
        size: st.size,
        mtimeMs: st.mtimeMs,
        btimeMs: st.birthtimeMs,
        kind: "image",
      });
    }
    // A row for a file that does not exist, in a folder that DOES: permanently
    // unreadable, so it must leave the pending set via the sentinel.
    entries.push({
      name: "GONE.JPG",
      size: 10,
      mtimeMs: Date.now(),
      btimeMs: Date.now(),
      kind: "image",
    });
    upsertScan(db, dir, null, entries);

    const r = await hashAllPending(db, {
      limit: 2,
      idle: () => Promise.resolve(),
    });
    expect(r.hashed).toBe(5);
    expect(r.failed).toBe(1);
    expect(r.paused).toBe(false);

    const pending = db
      .prepare(
        `SELECT COUNT(*) AS n FROM photos
          WHERE content_hash IS NULL AND hash_attempted = 0 AND stale = 0`
      )
      .get().n;
    expect(pending).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is single-flight: a concurrent call is a no-op", async () => {
    _resetHashingForTest();
    const db = new Database(":memory:");
    applySchema(db);
    let release;
    const gate = new Promise((r) => (release = r));
    const first = hashAllPending(db, { idle: () => gate });
    const second = await hashAllPending(db, { idle: () => Promise.resolve() });
    expect(second.alreadyRunning).toBe(true);
    release();
    await first;
  });

  it("PAUSES without marking when the drive goes away mid-sweep (#169)", async () => {
    // The #169 regression test. NOTE the trap recorded in the issue: do NOT
    // re-stat() the restored file and feed those values to upsertScan.
    // writeFileSync + utimesSync round-trips mtimeMs at sub-millisecond
    // precision, so the rescan would see a CHANGED file, hash_attempted would
    // reset, and the test would pass for the wrong reason. A real unmount does
    // not touch mtime — passing the ORIGINAL entry is the faithful model.
    _resetHashingForTest();
    const db = new Database(":memory:");
    applySchema(db);
    const dir = mkdtempSync(join(tmpdir(), "unmount-"));
    const file = join(dir, "IMG_0001.JPG");
    writeFileSync(file, "the original bytes");
    const st = statSync(file);
    const entry = {
      name: "IMG_0001.JPG",
      size: st.size,
      mtimeMs: st.mtimeMs,
      btimeMs: st.birthtimeMs,
      kind: "image",
    };
    upsertScan(db, dir, null, [entry]); // indexed while mounted

    rmSync(dir, { recursive: true, force: true }); // the DRIVE goes away

    const first = await hashAllPending(db, { idle: () => Promise.resolve() });
    expect(first.paused).toBe(true);
    expect(
      db.prepare(`SELECT hash_attempted FROM photos`).get().hash_attempted
    ).toBe(0); // NOTHING marked

    // Drive returns. File never modified -> the rescan reports the IDENTICAL stat.
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "the original bytes");
    _resetHashingForTest();
    upsertScan(db, dir, null, [entry]); // same size, same mtimeMs

    const second = await hashAllPending(db, { idle: () => Promise.resolve() });
    expect(second.hashed).toBe(1);
    expect(
      db.prepare(`SELECT content_hash FROM photos`).get().content_hash
    ).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

Update the imports at the top of `server/db/hashing.test.js` to include `mkdirSync` and `statSync` from `node:fs`, and drop the now-deleted `hashPendingPhotos` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/hashing.test.js`
Expected: FAIL — the `#169` case fails on `expect(first.paused).toBe(true)` (currently `undefined`) and on `hash_attempted` being `1` rather than `0`. **This is the red you must see before fixing.**

- [ ] **Step 3: Write minimal implementation**

Replace everything below `hashFile` in `server/db/hashing.js`:

```js
let hashingInFlight = false;

/** Photos whose content_hash is still NULL and that have not been written off.
 * Re-queried every batch, so it is the worklist AND the resume point.
 * `idx_photos_content_hash` makes the NULL range an index search, not a scan. */
function pendingHashRows(db, limit) {
  return db
    .prepare(
      `SELECT photos.id, folders.abs_path AS folder_abs_path, photos.filename
         FROM photos JOIN folders ON folders.id = photos.folder_id
        WHERE photos.content_hash IS NULL AND photos.hash_attempted = 0
          AND photos.stale = 0
        LIMIT ?`
    )
    .all(limit);
}

/**
 * Hash the WHOLE library's pending photos in the background, to completion.
 *
 * The drain, idle gating, cancellation, poison-file isolation and — critically —
 * the permanent/transient CLASSIFICATION all live in runSweep now. This file
 * used to hand-roll all of it, and that hand-rolled copy shipped #169: an
 * unmount mid-sweep marked every unreachable file hash_attempted=1, and because
 * upsertScan only clears that when size/mtime CHANGE (which an unmount does
 * not), those photos were excluded from hashing forever.
 *
 * What stays here is the part that is genuinely hashing's own: the worklist
 * query, and the sentinel WRITE. `hash_attempted` keeps exactly its old meaning.
 * A shared sentinel in content_hash is NOT usable — backupCoverage.js and
 * missing.js match files by EQUAL content_hash, so every unreadable file would
 * falsely match every other.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{limit?: number, idle?: () => Promise<void>, job?: object|null}} [opts]
 * @returns {Promise<{hashed: number, failed: number, paused: boolean, alreadyRunning?: boolean}>}
 */
export async function hashAllPending(
  db,
  { limit = 50, idle = whenIdle, job = null } = {}
) {
  if (hashingInFlight)
    return { hashed: 0, failed: 0, paused: false, alreadyRunning: true };
  hashingInFlight = true;

  const setHash = db.prepare(`UPDATE photos SET content_hash = ? WHERE id = ?`);
  const markAttempted = db.prepare(
    `UPDATE photos SET hash_attempted = 1 WHERE id = ?`
  );

  try {
    const { done, failed, paused } = await runSweep(job, {
      nextBatch: () => pendingHashRows(db, limit),
      process: async (rows) => {
        let written = 0;
        for (const row of rows) {
          const hash = await hashFile(join(row.folder_abs_path, row.filename));
          setHash.run(hash, row.id);
          written++;
        }
        return written;
      },
      markFailed: (row) => markAttempted.run(row.id),
      folderOf: (row) => row.folder_abs_path,
      idle,
    });
    return { hashed: done - failed, failed, paused };
  } finally {
    hashingInFlight = false;
  }
}

/** Test-only: clear the single-flight latch between cases. */
export function _resetHashingForTest() {
  hashingInFlight = false;
}
```

Update the imports at the top of `server/db/hashing.js`:

```js
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { whenIdle } from "../lib/interactive.js";
import { runSweep } from "../ml/sweep.js";
```

Add `"hash"` to the `JobType` typedef in `server/jobs/registry.js:3`:

```js
/** @typedef {"scan"|"export"|"materialize"|"undo-move"|"enrich"|"transcode"|"hash"} JobType */
```

and to `SELF_CLEARING` at `:16`, because a hash sweep that succeeded is not news
— same argument the comment there already makes for `enrich`:

```js
const SELF_CLEARING = new Set(["transcode", "enrich", "hash"]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/db/hashing.test.js server/ml/sweep.test.js`
Expected: PASS.

Then confirm the regression test is real — revert only the classification and watch it go red:

```bash
# In server/ml/sweep.js, temporarily change the probe to `if (false)`.
npx vitest run server/db/hashing.test.js
# Expected: the "#169" case FAILS. Restore the probe.
```

- [ ] **Step 5: Wire the job through at the two call sites**

In `server/api.js`, replace both bare calls (`:631` and `:652`) with a helper defined once near the other job helpers:

```js
/** Kick the background hasher with a JobsPanel entry, so hours of full-file
 * SHA-1 on a 114k library are visible and cancelable rather than invisible.
 * Fire-and-forget: it must never block a scan's response. */
function kickHashSweep(db) {
  const job = registry.create("hash", { label: "Hashing library contents" });
  hashAllPending(db, { job })
    .then((r) => {
      if (r.alreadyRunning) return registry.dismiss(job.id);
      if (r.paused) {
        return registry.update(job.id, {
          status: "failed",
          error: "paused — drive not available; resumes on the next scan",
        });
      }
      registry.finish(job.id, { hashed: r.hashed, failed: r.failed });
    })
    .catch((e) => registry.fail(job.id, e));
}
```

Replace `hashAllPending(db).catch(() => {});` at both sites with `kickHashSweep(db);`.

- [ ] **Step 6: Run the full server suite**

Run: `npx vitest run server/`
Expected: PASS. If `server/api.test.js` fails on an unexpected job type, add `hash` to whatever list it asserts.

- [ ] **Step 7: Commit**

```bash
npm run format
git add server/db/hashing.js server/db/hashing.test.js server/api.js server/jobs/registry.js
git commit -m "fix(hash): migrate onto runSweep — an unmount no longer excludes photos forever (#169, #160)"
```

---

### Task 4: Progress reporting for the hash sweep

`runSweep` already emits progress; the hasher needs to forward it so the JobsPanel row moves.

**Files:**

- Modify: `server/db/hashing.js`
- Modify: `server/api.js` (`kickHashSweep`)
- Test: `server/db/hashing.test.js`

**Interfaces:**

- Consumes: `hashAllPending` (Task 3).
- Produces: `hashAllPending` accepts `onProgress: ({done, failed}) => void` and forwards it to `runSweep`.

- [ ] **Step 1: Write the failing test**

```js
it("reports progress as it goes", async () => {
  _resetHashingForTest();
  const db = new Database(":memory:");
  applySchema(db);
  const dir = mkdtempSync(join(tmpdir(), "hash-progress-"));
  const entries = [];
  for (let i = 0; i < 4; i++) {
    const name = `P_${i}.JPG`;
    writeFileSync(join(dir, name), `bytes ${i}`);
    const st = statSync(join(dir, name));
    entries.push({
      name,
      size: st.size,
      mtimeMs: st.mtimeMs,
      btimeMs: st.birthtimeMs,
      kind: "image",
    });
  }
  upsertScan(db, dir, null, entries);
  const seen = [];
  await hashAllPending(db, {
    limit: 2,
    idle: () => Promise.resolve(),
    onProgress: (p) => seen.push(p.done),
  });
  expect(seen).toEqual([2, 4]);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/hashing.test.js -t "reports progress"`
Expected: FAIL — `seen` is `[]`, because `onProgress` is not forwarded.

- [ ] **Step 3: Write minimal implementation**

In `server/db/hashing.js`, add `onProgress = null` to the options destructure and pass it through to `runSweep`. Then in `server/api.js`, `kickHashSweep` gains the `onProgress` option it did not pass in Task 3:

```js
export async function hashAllPending(
  db,
  { limit = 50, idle = whenIdle, job = null, onProgress = null } = {}
) {
```

and inside the `runSweep` call:

```js
      folderOf: (row) => row.folder_abs_path,
      onProgress: onProgress ?? undefined,
      idle,
```

Then in `server/api.js`'s `kickHashSweep`, change `hashAllPending(db, { job })` to `hashAllPending(db, { job, onProgress })` with:

```js
    onProgress: ({ done, failed }) =>
      registry.update(job.id, {
        done,
        phase: failed
          ? `${done.toLocaleString()} hashed · ${failed} unreadable`
          : `${done.toLocaleString()} hashed`,
      }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/db/hashing.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format
git add server/db/hashing.js server/db/hashing.test.js server/api.js
git commit -m "feat(hash): report sweep progress to the JobsPanel (#160)"
```

---

### Task 5: The `hash` summary branch in the JobsPanel

Without this the row renders an empty summary — the exact gap the `enrich` branch's comment describes.

**Files:**

- Modify: `ui/src/lib/JobsPanel.svelte` (`summarize`, after the `transcode` branch)

**Interfaces:**

- Consumes: the `{ hashed, failed }` result shape from Task 3's `registry.finish`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the branch**

In `summarize(job)`, immediately after the `transcode` branch and before the final `return "";`:

```js
// Self-clears on success like enrich, so a row reaches here only when the
// sweep was CANCELED or paused — which still leaves a result worth reading.
if (job.type === "hash") {
  const hashed = r.hashed ?? 0;
  return r.failed
    ? `hashed ${hashed.toLocaleString()} · ${r.failed} unreadable`
    : `hashed ${hashed.toLocaleString()}`;
}
```

- [ ] **Step 2: Verify in the running app**

```bash
npm run dev
```

Add a folder (or rescan one) and open the JobsPanel. Expected: a "Hashing library contents" row appears with a moving `N hashed` phase and a working cancel button, then self-clears on success.

This is a Svelte + real-data change, so a passing unit suite is not sufficient — per the project's manual-verification convention, look at it.

- [ ] **Step 3: Commit**

```bash
npm run format
git add ui/src/lib/JobsPanel.svelte
git commit -m "feat(jobs): summary line for the hash sweep (#160)"
```

---

### Task 6: The one-time `hash_attempted` repair

Fixing the code forward does not un-mark rows already poisoned on 2.17.14–2.18.4.

**Files:**

- Modify: `server/db/schema.js` (inside `applySchema`, after the `hash_attempted` `ensureColumn` at `:160`)
- Test: `server/db/schema.test.js` (create if absent)

**Interfaces:**

- Consumes: nothing.
- Produces: `PRAGMA user_version` is now meaningful — `0` = pre-repair, `1` = repair applied. Future one-shot repairs increment it.

- [ ] **Step 1: Write the failing test**

```js
// server/db/schema.test.js
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";

/** Insert one photo row directly, bypassing upsertScan. */
function addPhoto(
  db,
  { filename, contentHash = null, attempted = 0, stale = 0 }
) {
  db.prepare(
    `INSERT INTO folders (abs_path, volume_id, last_scanned_at)
     VALUES ('/vol/photos', NULL, 0) ON CONFLICT(abs_path) DO NOTHING`
  ).run();
  const folderId = db
    .prepare(`SELECT id FROM folders WHERE abs_path = '/vol/photos'`)
    .get().id;
  db.prepare(
    `INSERT INTO photos (folder_id, filename, size, mtime, kind, stale,
                         content_hash, hash_attempted)
     VALUES (?, ?, 1, 1, 'image', ?, ?, ?)`
  ).run(folderId, filename, stale, contentHash, attempted);
}

describe("the #169 hash_attempted repair", () => {
  it("clears the marker on rows poisoned by an unmount", () => {
    const db = new Database(":memory:");
    applySchema(db);
    addPhoto(db, { filename: "POISONED.JPG", attempted: 1 });
    db.pragma("user_version = 0"); // pretend this db predates the repair
    applySchema(db);
    expect(
      db.prepare(`SELECT hash_attempted FROM photos`).get().hash_attempted
    ).toBe(0);
  });

  it("leaves an already-hashed row alone", () => {
    const db = new Database(":memory:");
    applySchema(db);
    addPhoto(db, { filename: "OK.JPG", contentHash: "abc", attempted: 1 });
    db.pragma("user_version = 0");
    applySchema(db);
    const row = db.prepare(`SELECT * FROM photos`).get();
    expect(row.content_hash).toBe("abc");
    expect(row.hash_attempted).toBe(1);
  });

  it("leaves a stale row alone", () => {
    const db = new Database(":memory:");
    applySchema(db);
    addPhoto(db, { filename: "STALE.JPG", attempted: 1, stale: 1 });
    db.pragma("user_version = 0");
    applySchema(db);
    expect(
      db.prepare(`SELECT hash_attempted FROM photos`).get().hash_attempted
    ).toBe(1);
  });

  it("runs EXACTLY ONCE — a later applySchema does not re-clear a fresh mark", () => {
    // Without the user_version gate this is the bug the repair would CREATE:
    // applySchema runs on every startup, so a genuinely corrupt file marked by
    // the FIXED code would be un-marked and re-attempted on every launch,
    // forever. That is the spin the sentinel exists to prevent.
    const db = new Database(":memory:");
    applySchema(db); // repair runs here, user_version -> 1
    addPhoto(db, { filename: "TRULY_CORRUPT.JPG", attempted: 1 });
    applySchema(db); // a later startup
    expect(
      db.prepare(`SELECT hash_attempted FROM photos`).get().hash_attempted
    ).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/schema.test.js`
Expected: FAIL — the first test gets `1`, because no repair exists yet.

- [ ] **Step 3: Write minimal implementation**

In `server/db/schema.js`, immediately after `ensureColumn(db, "photos", "hash_attempted", ...)`:

```js
// --- One-shot data repairs -----------------------------------------------
// Everything else in applySchema is idempotent BY CONSTRUCTION (CREATE TABLE
// IF NOT EXISTS, ensureColumn) and re-runs harmlessly on every startup. A
// data UPDATE is not, so it needs a gate — PRAGMA user_version, SQLite's
// built-in one-shot counter. It is the app's counter, not SQLite's, and only
// ever moves forward.
const dataVersion = db.pragma("user_version", { simple: true });
if (dataVersion < 1) {
  // #169: 2.17.14-2.18.4 marked every file unreachable during a hash sweep
  // hash_attempted=1, including a whole drive that was merely unmounted. Only
  // a size/mtime CHANGE clears that marker, and an unmount changes neither —
  // so those photos were excluded from hashing permanently, and
  // backup-coverage/dedup silently under-reported.
  //
  // Un-marking is safe: a genuinely unreadable file is re-attempted once and
  // re-marked by the (now correct) sweep. Rows that already HAVE a hash, and
  // stale rows, are untouched.
  //
  // Must run once, not per startup: re-running would also clear the marks the
  // FIXED code sets on genuinely corrupt files, re-attempting them forever.
  db.exec(`UPDATE photos SET hash_attempted = 0
              WHERE hash_attempted = 1 AND content_hash IS NULL AND stale = 0`);
  db.pragma("user_version = 1");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/db/schema.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
npm run format
git add server/db/schema.js server/db/schema.test.js
git commit -m "fix(index): one-time repair for libraries poisoned by #169"
```

---

### Task 7: Migrate `/api/enrich` onto `runSweep`

The behaviour-preserving half. Its existing tests are the specification.

**Files:**

- Modify: `server/api.js:742-801` (the enrich IIFE)

**Interfaces:**

- Consumes: `runSweep` (Task 2).
- Produces: no API change — same `202 {jobId, pending}`, same `{read, failed, elapsedMs}` result.

- [ ] **Step 1: Record the current green state**

Run: `npx vitest run server/api.test.js`
Expected: PASS. Note the count — it must be identical after the change. **No enrich test may be modified in this task.** If one needs changing, the extraction changed behaviour and is wrong.

- [ ] **Step 2: Replace the loop**

In `server/api.js`, replace the whole `(async () => { ... })();` block at `:742-801` with:

```js
(async () => {
  const t0 = performance.now();
  try {
    // `forced` (re-read mode) is a FIXED in-memory list; the sweep's list is
    // drained from SQL as it goes. runSweep does not care which — nextBatch
    // is a callback precisely so both modes share one loop.
    let taken = 0;
    const { done, failed } = await runSweep(job, {
      nextBatch: () => {
        if (!forced) return pendingMetaPhotos(db, { limit: BATCH });
        const slice = forced.slice(taken, taken + BATCH);
        taken += slice.length;
        return slice;
      },
      process: (batch) => enrichBatch(db, processing, batch),
      // width=0 is the metadata sweep's "attempted, nothing there" sentinel
      // — see db/enrich.js. This file simply has no readable metadata.
      markFailed: (p) => writeMeta(db, p.id, {}),
      folderOf: (p) => dirname(p.path),
      onProgress: ({ done: d }) =>
        registry.update(job.id, {
          done: d,
          phase: `${d.toLocaleString()} of ${total.toLocaleString()} read`,
        }),
    });
    registry.finish(job.id, {
      read: done - failed,
      failed,
      elapsedMs: Math.round(performance.now() - t0),
    });
  } catch (e) {
    registry.fail(job.id, e);
  }
})();
```

Add `dirname` to the `node:path` import at the top of `server/api.js` if it is not already there, and import `runSweep`:

```js
import { runSweep } from "./ml/sweep.js";
```

- [ ] **Step 3: Run the tests — they must be unchanged and green**

Run: `npx vitest run server/api.test.js`
Expected: PASS, same count as Step 1, with no test file edited.

- [ ] **Step 4: Run the whole suite and the e2e specs**

```bash
npm test
npx playwright test e2e/ 2>&1 | tail -20
```

Expected: PASS. The e2e specs must be green **and unmodified**.

- [ ] **Step 5: Commit**

```bash
npm run format
git add server/api.js
git commit -m "refactor(enrich): migrate onto runSweep — behaviour unchanged (#160)"
```

---

### Task 8: `server/ml/` — the sidecar substrate

The interface, the supervised child, and the worker. No model, no inference.

**Files:**

- Create: `server/ml/MLService.js`
- Create: `server/ml/OnnxMLService.js`
- Create: `server/ml/worker/index.js`
- Test: `server/ml/OnnxMLService.test.js`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `class MLService` with `embedImages(paths)`, `embedTexts(strings)`, `detectFaces(path)` — all throw `new Error("not implemented")`.
  - `class OnnxMLService extends MLService` with `constructor({ spawn?, workerPath? })`, `health() => Promise<{ok, ort, providers, pid}>`, `stop() => void`.

- [ ] **Step 1: Write the abstract base**

```js
// server/ml/MLService.js
/**
 * The ML capability seam, mirroring server/processing/ProcessingService.js
 * deliberately — same shape of problem, and the codebase already knows how to
 * read that shape. ProcessingService.js:11 always named a future ML sidecar;
 * this is it, and keeping it abstract is what leaves the Python swap open.
 *
 * Every method throws here. An implementation that cannot do one of these is
 * expected to keep throwing rather than return a plausible empty answer — a
 * silently-empty embedding set is the "reports plausible numbers and is wrong"
 * failure this program exists to avoid.
 *
 * @typedef {{box: [number, number, number, number], score: number, vec: Float32Array}} Face
 */
export class MLService {
  /** @param {string[]} _paths @returns {Promise<Float32Array[]>} */
  async embedImages(_paths) {
    throw new Error("MLService.embedImages is not implemented");
  }
  /** @param {string[]} _strings @returns {Promise<Float32Array[]>} */
  async embedTexts(_strings) {
    throw new Error("MLService.embedTexts is not implemented");
  }
  /** @param {string} _path @returns {Promise<Face[]>} */
  async detectFaces(_path) {
    throw new Error("MLService.detectFaces is not implemented");
  }
}
```

- [ ] **Step 2: Write the failing supervision test**

```js
// server/ml/OnnxMLService.test.js
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { OnnxMLService } from "./OnnxMLService.js";

/** A fake child process. No real spawn — the default suite must never fork. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => child.emit("exit", null, "SIGTERM"));
  child.pid = 4242;
  /** Reply to the request just written, as the worker would. */
  child.reply = (obj) => child.stdout.emit("data", JSON.stringify(obj) + "\n");
  return child;
}

describe("OnnxMLService", () => {
  it("round-trips a health request over JSON-lines", async () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    const p = svc.health();
    // The request went out as one line of JSON.
    const sent = JSON.parse(child.stdin.write.mock.calls[0][0]);
    expect(sent.op).toBe("health");
    child.reply({ id: sent.id, ok: true, ort: "1.20.0", providers: ["cpu"] });
    await expect(p).resolves.toMatchObject({ ok: true, ort: "1.20.0" });
    svc.stop();
  });

  it("rejects the in-flight request when the child dies, and stays usable", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => fakeChild());
    const svc = new OnnxMLService({ spawn: () => child });
    const p = svc.health();
    child.emit("exit", 1, null); // segfault
    await expect(p).rejects.toThrow(/exited/i);
    // The service is not poisoned — the app stays usable without ML.
    expect(() => svc.stop()).not.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("respawns on the next request after a crash", async () => {
    const children = [fakeChild(), fakeChild()];
    let n = 0;
    const svc = new OnnxMLService({ spawn: () => children[n++] });
    const first = svc.health();
    children[0].emit("exit", 1, null);
    await expect(first).rejects.toThrow();

    const second = svc.health();
    const sent = JSON.parse(children[1].stdin.write.mock.calls[0][0]);
    children[1].reply({ id: sent.id, ok: true, ort: "1.20.0", providers: [] });
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(n).toBe(2);
    svc.stop();
  });

  it("stop() kills the child and later requests respawn", () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    svc.health().catch(() => {});
    svc.stop();
    expect(child.kill).toHaveBeenCalled();
  });

  it("surfaces a malformed line as a rejection, not a crash", async () => {
    const child = fakeChild();
    const svc = new OnnxMLService({ spawn: () => child });
    const p = svc.health();
    child.stdout.emit("data", "not json\n");
    // A garbage line must not take the process down; the request is still
    // pending, so kill the child to settle it.
    child.emit("exit", 1, null);
    await expect(p).rejects.toThrow();
    svc.stop();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run server/ml/OnnxMLService.test.js`
Expected: FAIL — `Failed to resolve import "./OnnxMLService.js"`.

- [ ] **Step 4: Write the supervisor**

```js
// server/ml/OnnxMLService.js
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MLService } from "./MLService.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Spawns and supervises the ML child process. Does NO inference itself.
 *
 * Out of process is not optional. In-process inference would contend for the
 * same 16-slot libuv threadpool server/index.js:19 reserves for libvips — the
 * failure already measured in lib/interactive.js (thumbnails 15ms -> 90ms under
 * a sweep, tiles abandoned mid-scroll) — and a native-addon segfault would take
 * the whole app down. The child IS the resilience requirement: hard resource
 * boundary, kill switch, crash isolation.
 *
 * This slice ships supervision and one op (`health`). Model loading and real
 * inference arrive with #161, which has a cost to measure them against.
 *
 * `spawn` is injectable so the default test suite never forks a real process.
 */
export class OnnxMLService extends MLService {
  #spawn;
  #workerPath;
  #child = null;
  #pending = new Map();
  #seq = 0;
  #buf = "";

  constructor({ spawn = nodeSpawn, workerPath } = {}) {
    super();
    this.#spawn = spawn;
    this.#workerPath = workerPath ?? join(HERE, "worker", "index.js");
  }

  #ensureChild() {
    if (this.#child) return this.#child;
    // In a packaged build the child runs on ELECTRON's ABI, not Node's —
    // ELECTRON_RUN_AS_NODE makes the Electron binary behave as node. #67 is the
    // cautionary tale: a Node-ABI native addon in an Electron build crashes on
    // launch, and electron-builder's own rebuild was a silent no-op.
    const child = this.#spawn(process.execPath, [this.#workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.stdout.on("data", (chunk) => this.#onData(String(chunk)));
    child.on("exit", (code, signal) => {
      this.#child = null;
      // Fail every in-flight request rather than leaving a caller hanging: a
      // sweep waiting forever on a dead child is worse than a failed batch.
      const err = new Error(
        `ML worker exited (code ${code ?? "null"}, signal ${signal ?? "null"})`
      );
      for (const { reject } of this.#pending.values()) reject(err);
      this.#pending.clear();
    });
    this.#child = child;
    return child;
  }

  #onData(text) {
    this.#buf += text;
    let nl;
    while ((nl = this.#buf.indexOf("\n")) !== -1) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // A garbage line is the worker's problem, not grounds to kill the app.
        continue;
      }
      const waiter = this.#pending.get(msg.id);
      if (!waiter) continue;
      this.#pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error));
      else waiter.resolve(msg);
    }
  }

  /** One request, one reply. @param {object} req @returns {Promise<any>} */
  #request(req) {
    const child = this.#ensureChild();
    const id = `r${++this.#seq}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ ...req, id }) + "\n");
    });
  }

  /** Is the runtime there, and what can it run on?
   * @returns {Promise<{ok: boolean, ort: string, providers: string[], pid: number}>} */
  health() {
    return this.#request({ op: "health" });
  }

  /** Kill the child. Any later request respawns it. */
  stop() {
    if (!this.#child) return;
    this.#child.kill();
    this.#child = null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/ml/OnnxMLService.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 6: Write the worker**

```js
// server/ml/worker/index.js
/**
 * The ML child process.
 *
 * JSON-lines over stdio, one request at a time. Deliberately tiny in this
 * slice: it loads onnxruntime-node and reports what it found. Model loading,
 * an idle unload timer, and real inference arrive with #161.
 *
 * Nothing here may write to stdout except a reply line — stdout IS the
 * protocol. Diagnostics go to stderr.
 */
let ort = null;
let loadError = null;
try {
  ort = (await import("onnxruntime-node")).default;
} catch (e) {
  loadError = e;
}

process.stdin.setEncoding("utf8");
let buf = "";

process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) handle(line);
  }
});

/** @param {string} line */
function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // unparseable input is the parent's bug; stay alive
  }
  try {
    if (req.op === "health") {
      if (loadError) {
        return reply({
          id: req.id,
          error: `onnxruntime-node: ${loadError.message}`,
        });
      }
      return reply({
        id: req.id,
        ok: true,
        ort: ort.version ?? "unknown",
        providers: ort.listSupportedBackends?.().map((b) => b.name) ?? ["cpu"],
        pid: process.pid,
      });
    }
    reply({ id: req.id, error: `unknown op: ${req.op}` });
  } catch (e) {
    reply({ id: req.id, error: String(e?.message ?? e) });
  }
}

/** @param {object} obj */
function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
```

- [ ] **Step 7: Add the gated integration test**

Append to `server/ml/OnnxMLService.test.js`:

```js
// The ONLY test that spawns a real child. Off by default so the suite stays
// fast and hermetic — but without it, "does the worker start at all" would be
// discovered by a user rather than by CI.
const integration =
  process.env.ML_INTEGRATION === "1" ? describe : describe.skip;

integration("OnnxMLService (real child)", () => {
  it("answers a health request from a genuinely spawned worker", async () => {
    const svc = new OnnxMLService();
    const h = await svc.health();
    expect(h.ok).toBe(true);
    expect(typeof h.ort).toBe("string");
    expect(h.pid).toBeGreaterThan(0);
    svc.stop();
  }, 30_000);
});
```

- [ ] **Step 8: Verify both modes**

```bash
npx vitest run server/ml/            # integration skipped
ML_INTEGRATION=1 npx vitest run server/ml/OnnxMLService.test.js
```

Expected: first run passes with the integration block skipped; second run passes with a real child. The second requires Task 9's dependency install — if `onnxruntime-node` is not yet installed, do Task 9 first and return here.

- [ ] **Step 9: Commit**

```bash
npm run format
git add server/ml/
git commit -m "feat(ml): MLService seam + supervised ONNX child process (#160)"
```

---

### Task 9: Packaging, dependency, version, changelog

The #67 trap, closed before anything depends on it.

**Files:**

- Modify: `package.json` (dependency, `rebuild:electron`, `asarUnpack`, `version`)
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: `server/ml/worker/index.js` (Task 8) — the thing being packaged.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Install the runtime**

```bash
npm install onnxruntime-node
```

- [ ] **Step 2: Add it to the rebuild list**

In `package.json:22`, `rebuild:electron` becomes:

```json
"rebuild:electron": "electron-rebuild -f -w better-sqlite3 -w onnxruntime-node",
```

Leave `npmRebuild: false` alone. #67: electron-builder's built-in rebuild was a no-op that shipped a Node-ABI binary and crashed the app on launch, which is why CI rebuilds explicitly.

- [ ] **Step 3: Add it to `asarUnpack`**

In the `asarUnpack` array (`package.json:88`), after `better-sqlite3`:

```json
      "node_modules/onnxruntime-node/**",
```

A native addon cannot be loaded from inside an asar archive — this is the same treatment `better-sqlite3`, `sharp`, and the ffmpeg binaries already get.

- [ ] **Step 4: Verify the rebuild and the packaged child**

```bash
npm run rebuild:electron
ML_INTEGRATION=1 npx vitest run server/ml/OnnxMLService.test.js
npm run rebuild:node   # restore the Node ABI for the normal test suite
npm test
```

Expected: all green. If the integration test fails after `rebuild:electron`, that is correct — the addon is on Electron's ABI and plain `node` cannot load it. Run it again after `rebuild:node`.

- [ ] **Step 5: Bump the version**

`package.json` → `"version": "2.18.5"`.

- [ ] **Step 6: Write the changelog entry**

At the top of `CHANGELOG.md`, newest first, user-facing lines only:

```markdown
## 2.18.5

- Unmounting a drive while the library was being hashed no longer excludes those
  photos from hashing forever. Libraries already affected are repaired
  automatically on the next launch — no rebuild needed. (#169)
- Content hashing now appears in the Jobs panel with progress and a cancel
  button, instead of running invisibly. (#160)
- Groundwork for on-device photo understanding: the background runtime that
  future face and similarity features will run on. No models are downloaded and
  nothing changes in the app yet. (#160)
```

- [ ] **Step 7: Full verification**

```bash
npm run format
npm test
npm run build
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(ml): package onnxruntime-node, ship 2.18.5 (#160, #169)"
```

---

### Task 10: Final verification against the real app

The project's standing rule: a passing suite plus a plausible screenshot is not sufficient for anything touching sweeps or feed state.

**Files:** none (verification only).

- [ ] **Step 1: Run everything**

```bash
npm test
npx playwright test e2e/ 2>&1 | tail -20
```

Expected: green, with **no e2e spec modified** in this branch. Confirm with `git diff --stat main -- e2e/` — it must be empty.

- [ ] **Step 2: Drive the real app**

```bash
npm run dev
```

Then, against a **read-only** test folder (never the user's real library — see CLAUDE.md):

1. Add a folder. Confirm the JobsPanel shows "Hashing library contents" with a moving count, and that scrolling the grid stays smooth while it runs (the idle gate is doing its job).
2. Cancel the hash job mid-run. Confirm it stops, reports as canceled, and the app stays usable.
3. Rescan. Confirm hashing resumes and finishes rather than starting over.
4. Run "Read metadata" (enrich). Confirm progress, cancel, and the summary line all behave exactly as before this branch.

- [ ] **Step 3: Confirm the sweep count**

```bash
grep -rn "for (;;)" server/ --include="*.js" | grep -v test
```

Expected: exactly two hits — `server/ml/sweep.js` (the shared loop) and `server/api.js:2134` (the album-name dedup loop, which is not a sweep and stays).

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin worktree-structured-giggling-tide
gh pr create --title "ML sidecar foundation + generalized idle sweep (#160, #169)" --body "$(cat <<'EOF'
Closes #160. Closes #169.

Spec: `docs/superpowers/specs/2026-07-25-ml-sidecar-and-sweep-design.md`
Plan: `docs/superpowers/plans/2026-07-25-ml-sidecar-and-sweep.md`

## What this is

The substrate every later ML slice (#161, #166) depends on, plus the bug fix
that falls out of building it properly.

**One sweep, not three.** `/api/enrich` and `hashAllPending` were the same drain
loop written twice by hand, and they had already diverged — enrich had a job,
progress, cancellation and per-file isolation; the hasher had none. Both now run
through `runSweep`. The caller keeps owning its sentinel *write* (the three
sentinels are genuinely different shapes); `runSweep` takes over the
*classification*, which is the part each copy answered for itself and the part
the hasher got wrong.

**#169 is that classification.** An unmount mid-sweep used to mark every
unreachable file `hash_attempted = 1`, and `upsertScan` only clears that when
size/mtime change — which an unmount does not. Those photos were excluded from
hashing permanently, and backup-coverage/dedup silently under-reported. Now the
sweep probes whether the folder is still reachable, pauses if not, and marks
nothing.

**Libraries already poisoned are repaired**, gated on `PRAGMA user_version` so
it runs exactly once — re-running it every startup would clear the marks the
fixed code sets on genuinely corrupt files, re-attempting them forever.

**The sidecar** is supervision plus packaging, no model: `MLService` (the seam
`ProcessingService.js:11` always named), `OnnxMLService` (spawn, crash
isolation, respawn), and a worker answering one `health` op. `onnxruntime-node`
gets the same `asarUnpack` + explicit `electron-rebuild` treatment
`better-sqlite3` has, closing the #67 trap now rather than during a slice that
also has a model to choose.

## Verification

- `runSweep` unit-tested including the #169 regression (watched red before the fix).
- Enrich's tests are **unmodified** and green — that is the proof its behaviour was preserved.
- e2e green and unmodified (`git diff main -- e2e/` empty).
- Real child spawned only under `ML_INTEGRATION=1`; the default suite forks nothing and downloads nothing.
- Driven in the real app: hash job shows progress, cancels, resumes on rescan, and does not stall scrolling.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01QeCRYTHtwY7F2REs2Qwump
EOF
)"
```

---

## Notes for the implementer

**Do not add a third sweep.** If a later need does not fit `runSweep`, extend it — the whole point of this slice is that the pattern stops being copied. CLAUDE.md records the same rule for the feed-window guard, where six hand-copies caused two shipped bugs.

**The classification belongs to `runSweep`, the sentinel write belongs to the caller.** If you find yourself adding a `sentinelKind` parameter, or moving `hash_attempted` into `runSweep`, stop — you are re-unifying three things the spec deliberately keeps separate.

**Watch every regression test fail before you fix it.** Tasks 3 and 6 both say so explicitly. A test that never failed proves nothing.

**`ml_status`, model download, and `thumbCachePath` are all #161.** Do not build them here; there is nothing yet to test them against.
