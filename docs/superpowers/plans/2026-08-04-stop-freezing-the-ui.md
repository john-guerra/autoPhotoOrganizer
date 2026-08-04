# Stop freezing the UI

**Source of truth:** `docs/ARCHITECTURE-REVIEW-2026-08-04.md`. That document is
measured; this one is only the running order. Where they disagree, the review
wins.

**The one sentence:** give the server one job — answering requests — and put
every unit of work that can exceed a frame budget on a worker, behind a single
writer.

## What we were wrong about, so it is not re-derived

Three fixes failed because all three addressed **A** and left B, C and D
standing:

|       |                                                               |            |
| ----- | ------------------------------------------------------------- | ---------- |
| **A** | yieldable JS math saturating the shared loop                  | #231, #279 |
| **B** | work with **no yield point at all**                           | #281       |
| **C** | refusal latches making the scheduler unreachable              | #257, #279 |
| **D** | **the client lies** — the server is up, the UI says otherwise | #282       |

And the correction that changes the approach: **cooperative yielding is not
doomed, it was mistuned by 100×** — but the test written to protect it asserts
an _injected_ budget and would pass if the shipped constant were a hundred
million. Fixing a number without a test that fails when it is wrong is what got
us here three times.

Three of my own claims were measured and corrected: write locks do not block
main-thread reads (the real hazard is `DEFERRED` transactions failing with
`SQLITE_BUSY_SNAPSHOT`); #281 is `clearCache` (8.42 s) not the DB (1.3 s); and
**`whenIdle()` is a microtask that yields nothing** — 10.9M awaits, 0
macrotasks.

Storage stays SQLite with the synchronous driver. DuckDB was considered and
rejected on evidence (§8).

---

## Step 0 — retune, and prove it with a test · hours · reversible

- [ ] `YIELD_COMPARISONS` 200,000 → 2,000.
- [ ] **Yield mid-face.** `sinceYield += centroids.length` makes the granularity
      one face; at ~25,758 people that is ~12 ms regardless of the budget.
      Chunk the centroid list inside `bestPerson`. **Without this the constant
      change looks right on a small library and does nothing on John's.**
- [ ] Yield + abort check in `clusterLeftovers` and `personCentroidVectors` —
      two blocks inside the "yielding" function that never yield.
- [ ] `await idle(); await breathe();` wherever `idle()` is the only yield —
      `nearDupeSweep.js:118` and `places.js:90` first, since `idle()` alone
      yields nothing.
- [ ] **T1**: `expectNoBlockOver(ms, fn)` against a 5 ms interval timer, applied
      to the **shipped** constants. Revert #231's fix → red, or it is not the
      test #231 asked for.

## Step 1 — the three contract-2 one-liners · a day · reversible

Each is a shipped promise currently broken.

- [ ] The cancel **route** accepts `paused` (`api.js:987`). The registry half
      landed in #260; the route half did not.
- [ ] `dismiss` refuses a genuinely parked run (`registry.js:151`).
- [ ] The pause reason names the blocker instead of saying "waiting".

## Step 2 — reset and cache become jobs · a day · reversible · NO worker needed

The highest damage-per-line change in the review, and it depends on nothing
else. Do it **before** the worker.

- [ ] Chunk the DB wipe, ~1,000 rows per transaction.
- [ ] `.immediate()` on every bulk transaction: `resetLibrary`, `saveClusters`,
      `replaceNeighborSim`, `mergePersonsBulk`, `undoMerge`, `setKeepScope`,
      `deletePhotosByIds`. `db.transaction()` is DEFERRED and **fails** under
      concurrency.
- [ ] Batch the cache clear with real yields and progress. This is the 8.4 s
      (→ ~42 s across buckets), not the DB.
- [ ] Both behind a job, summarised: "Cleared 125,431 photos and 1.5 GB of
      thumbnails." A second Reset while one runs is refused **specifically**.
- [ ] **T3**: every route answers within a budget, p99 < 200 ms, with an
      allowlist of exemptions each carrying an issue number. This is the test
      that would have caught #281 before it was filed.

Closes #281.

## Step 3 — tell the truth about being busy · half a day · #282

- [ ] `/api/health` carries event-loop lag and the active job count.
- [ ] The client distinguishes **healthy / busy / unreachable**. The rule: if
      `/api/health` ever answers, the connection was never lost.
- [ ] Busy names the job and links to it.

Independent of the structural work, and it converts the most alarming message
in the app from false to true.

## Step 4 — the writer worker · a week · reversible behind a flag

- [ ] Generalise `server/projection/runProjection.js` into `server/workers/` —
      a pool, not a copy per feature. Pool size `min(4, cores - 2)`.
- [ ] Move `groupRemaining` **first**: most evidence, already takes
      `checkpoint`/`signal`, touches two query functions.
- [ ] Keep the main-thread path behind a flag until a full 125k grouping has
      run through the worker end to end.
- [ ] **T4**: extend `asarPackaging.test.js` with the
      better-sqlite3-in-a-worker probe. Verified working on Electron 43,
      darwin/arm64 — this stops it rotting.

Then the sweeps, then reset.

## Step 5 — the read-only main connection · POINT OF NO RETURN

- [ ] `new Database(file, { readonly: true })` in the main process.
- [ ] **T2**: `expect(() => getDb().prepare("INSERT …").run()).toThrow(/SQLITE_READONLY/)`.

**The only invariant a developer cannot forget**, because it does not depend on
them writing a test for their new loop. Do not attempt until every writer has
moved.

## Step 6 — the scheduler gets a lease, the latches go · #257, #279

- [ ] A semaphore of 1 **per resource class** (`onnx`, `db-write`, `vips`),
      acquired after `checkpoint()`, released on park. The scheduler currently
      has **no** mutual exclusion — deleting the latches without this would let
      two sweeps overlap.
- [ ] Delete the six `inFlight` booleans.
- [ ] Convert the eleven 409s to queue entries: "Queued behind Grouping faces
      (2 minutes left)" with a **Run first** button.
- [ ] Make preemption visible: "Paused — your folder scan is running first",
      and "Waiting for 3 jobs" when parked indefinitely.

Closes #257, #279. This is Phase 2 of the old design, finished.

---

## Not doing, and why

- **Not DuckDB, not an async driver, not a different runtime.** §8. A blocking
  query blocks either way, and DuckDB loses the generated expression indexes
  the feed depends on.
- **Not a separate service process.** IPC serialization per row, a second
  process to supervise and auto-update. `resourceLimits` already gives a worker
  a separate heap. The ONNX child is separate for a real reason; vector math
  and DELETEs have none.
- **Not an ANN index — yet.** It is the right long-term answer to 4.9 billion
  dot products, and it is an _algorithm_ change that alters grouping RESULTS.
  File it separately; mixing a correctness change into a latency fix is how you
  lose the ability to tell which one broke something.
- **Not steps 4–6 in one PR.**
- **Not another constant tuned without a test that fails when it is wrong.**

## The honest promise

"Runs in the background, fast, without affecting the UI" is not simultaneously
satisfiable on one core — the exchange rate is 100× smaller yield budget buys
40× better latency for 35% throughput. On 14 cores it is. The offer is:
**never affects the UI, and as fast as the idle cores allow** — which measured
_faster_ than today (533 vs 500 faces/s while serving 67× the traffic).
