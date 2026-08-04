# Architecture review: why the UI keeps freezing

**Date** 2026-08-04 · **Against** 2.19.19 · **Issues** #231, #257, #279, #281
· **Suspect design** `docs/superpowers/specs/2026-07-31-unified-scan-pipeline-design.md`

Everything below that is stated as a number was measured on this machine, this
week, with scripts I wrote for it. Everything stated without a number is
labelled as reasoning or as unverified. Where the brief, the issues, the design
doc or the previous agent asserted something without measuring it, I say so.

---

## 0. Verdict

**The premise I was given is half wrong, and the half that is wrong is why
three fixes failed.**

> _"four bugs are one root cause — heavy work sharing an event loop, defended
> only by cooperative yielding"_

They are not one root cause. They are **three, plus one nobody filed**:

|       |                                                                                | Fix that works                                                | Fix that does not                                              |
| ----- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------- |
| **A** | Yieldable JS math saturating the shared loop (#231, #279 part 2)               | a worker thread — or, measurably, a 100× smaller yield budget | anything that assumes A is the whole story                     |
| **B** | Work with **no yield point at all** (#281, and a long tail)                    | restructuring the work (batching, jobs, a worker)             | tuning a yield budget — there is nothing to tune               |
| **C** | A refusal-latch layer that makes the scheduler unreachable (#257, #279 part 1) | deleting the latches and giving the scheduler a lease         | anything to do with the event loop                             |
| **D** | **The client lies.** The server is up; the UI says the connection was lost     | a busy/unreachable distinction in `/api/health`               | fixing A, B and C — the banner will still be wrong, just rarer |

Each of the three fixes so far addressed **A**, correctly, and left B, C and D
standing. That is the whole story of why the report keeps coming back.

And the sharpest finding of the review is one nobody has said out loud:

> **Cooperative yielding is not doomed here. It was mistuned by two orders of
> magnitude, and the test that was written to protect it asserts the wrong
> thing.**

`server/ml/faceClusters.test.js:367` — the test added for #231 — injects
`yieldPairs: 5_000` and asserts the loop honours _the injected budget_. It says
nothing about the shipped constant (`YIELD_PAIRS = 100_000`,
`YIELD_COMPARISONS = 200_000`) and nothing about milliseconds. **It would pass
identically if the shipped constant were a hundred million.** The mechanism is
tested; the number that is actually wrong is not.

I measured the shipped number: **64–91 ms of unyieldable CPU between yields**
(§2, M1). Dropping it to 2,000 takes `/api/health` from 210 ms to **5 ms**
(M5). That is a one-line change available today.

It is also not the end state, because it costs 35% of grouping throughput while
the user is browsing (M5/M6), and because it does nothing for B. The end state
is §7.

---

## 1. How I measured, and where to distrust it

**Machine** Apple M4 Max, 14 logical cores, 36 GB, macOS 26.6, Node 24.15.0,
better-sqlite3 12.11.1, Electron 43.2.0. This machine is **faster than John's
is likely to be**, so every blocking number below is a lower bound.

**Fixture** A synthetic index built with the app's own `applySchema`:
**125,000 photos, 190,000 faces** (the 1.52 faces/photo ratio from #231's real
measurement, scaled to the stated 125k target), 512-d int8 vectors, 5,000
identities with intra-identity cosine ≈ 0.92 and inter-identity ≈ 0.02.

**Two caveats that matter, stated up front:**

1. **The identity count is optimistic.** `server/projection/runProjection.js:19`
   records that John's real library produced **25,758 people** at
   `minFaces: 1` from 48,585 faces — roughly one person per two faces. My
   fixture has one per 38. Since `bestPerson` compares each face against
   _every_ centroid, **the real library is far worse than what I measured.**
   Every grouping number below should be read as a floor.
2. **I never touched John's library**, and I could not reproduce the 4-second
   watchdog timeout from grouping alone (M3). If it happens on his machine, the
   difference is almost certainly the person count — and I would want that
   number before believing any explanation of #279, including mine.

**Reproduction** The scripts are described in §12 with enough detail to rebuild
in about twenty minutes. I deliberately did not leave 1.2 GB of generated
fixtures in the tree.

---

## 2. The measurements

### M1 — What `YIELD_COMPARISONS = 200_000` actually costs

`dot()` (`server/ml/quantize.js:63`) runs at **2,197 dot products/ms** at
dim 512 (1,125 M multiply-accumulates/s) in plain JS.

> 200,000 comparisons = **64–91 ms of unyieldable CPU**, every yield, forever.

The unit was fixed by #231 (rows → comparisons). The **magnitude was never
measured.** 91 ms is 5.5 display frames; the sweep's own thumbnail budget
(`server/lib/interactive.js:6`) is 15 ms.

### M2 — The loop is not blocked, it is saturated

Real `groupRemaining` on the real fixture, 120 s, with a 1 ms interval timer
watching:

```
1ms-timer gaps: p50 80.9  p95 82.5  p99 83.8  MAX 120 ms   (1,590 turns in 120,000 ms)
100ms-timer starvation: worst 87 ms
```

**The event loop was unavailable 98.7% of wall time**, handed out in ~81 ms
slices. Note what this does to #231's own metric: "worst gap between yields"
went from 10,343 ms to 87 ms — a **119× improvement**, correctly achieved — and
the user still reported a freeze. A metric that improves 119× while the
complaint is unchanged is a metric measuring the wrong thing.

### M3 — What the user actually experiences (live server, real route)

Real Express app, real `POST /api/ml/faces/cluster`, whole library:

|                           | idle  | during grouping               |
| ------------------------- | ----- | ----------------------------- |
| `/api/health` p50         | 19 ms | **210 ms** (p99 220, max 226) |
| `/api/feed?limit=100` p50 | 9 ms  | **217 ms** (p99 258, max 289) |
| requests served in 45 s   | —     | **113**                       |

**Zero 4-second timeouts on my fixture.** So on a 5,000-person library,
grouping degrades the app 11× but does _not_ produce John's banner. See caveat 1.

### M4 — The same code, unchanged, in a worker thread

Identical `groupRemaining`, identical library, its own `better-sqlite3`
connection in a `worker_threads` Worker, while the real Express app serves:

|                         | main loop (M3) | worker thread    |
| ----------------------- | -------------- | ---------------- |
| `/api/health` p50 / max | 210 / 226 ms   | **0 / 2 ms**     |
| `/api/feed` p50 / max   | 217 / 289 ms   | **6 / 13 ms**    |
| requests served in 45 s | 113            | **7,583** (67×)  |
| grouping throughput     | ~500 faces/s   | **~533 faces/s** |

Better on **both** axes. No ABI problem, no rebuild, no protocol.

### M5 — The yield budget sweep (the finding that contradicts the thesis)

Same server, same library, same code path on the main loop. Only `yieldEvery`
changes:

| `yieldEvery`          | health p50 | health p99 | feed p50  | requests/20 s | faces/s |
| --------------------- | ---------- | ---------- | --------- | ------------- | ------- |
| **200,000** (shipped) | 210 ms     | 249 ms     | 217 ms    | 50            | 500     |
| 20,000                | 22 ms      | 59 ms      | 28 ms     | 395           | 450     |
| **2,000**             | **5 ms**   | **6 ms**   | **11 ms** | 1,320         | 325     |
| 200                   | 4 ms       | 7 ms       | 11 ms     | 1,350         | 325     |

**Cooperative yielding is tunable here.** A 100× smaller budget restores
near-idle interactive latency. It costs 35% of throughput _while the user is
browsing_, and nothing when they are not (M6). The curve flattens at 2,000 —
below that you pay nothing more and gain nothing more.

### M6 — The yield itself is free; the cost is real service work

With no HTTP traffic at all: `yieldEvery = 200,000` → **573 faces/s**;
`yieldEvery = 2,000` → **575 faces/s**. `setImmediate` overhead is
indistinguishable from noise. The 35% in M5 is the CPU genuinely spent
answering requests — i.e. it is the thing the user asked for.

### M7 — `clearCache()`, the real #281

`server/lib/cacheStats.js:109` — one `statSync` + one `unlinkSync` per file:

```
125,000 files (1.54 GB): 8.42 s     100ms-timer starved 8,420 ms
```

**8.4 seconds of hard block on a fast local SSD.** And that is one bucket:
`THUMB_BUCKETS = [160, 320, 480, 640, 1024]` (`cachePaths.js:65`), so a warmed
125k library holds **up to 625,000 files** → **~42 s** by linear extrapolation
(not measured directly). The UI's watchdog times out at 4,000 ms
(`ui/src/lib/serverHealth.js:38-40`) and backs off 800/1600/3200/6400 ms, so
"attempt 4" corresponds to roughly **22 seconds of block**. `clearCache` alone
gets there.

### M8 — `resetLibrary()`

`server/db/photos.js:375`, one transaction, full cascade:

```
1,319 ms   (125,000 photos, 190,000 faces)
```

**With `photo_embeddings`, `ml_status`, `near_dupe_groups`,
`photo_neighbor_sim` and `projection_point` all EMPTY.** A real library
populates every one of them. 1.3 s is a floor, and it is the _smaller_ half of
#281 — `clearCache` is 6× worse.

### M9 — A full table scan hiding inside the batch loop

The grouping worklist (`server/db/faces.js:549`) plans as **`SCAN photo_faces`**.
No index serves `person_id IS NULL`, because the only person index is _partial_:
`idx_photo_faces_person … WHERE person_id IS NOT NULL` (`schema.js:538`).

| state                     | `ungroupedFaceRows(limit 500)`           |
| ------------------------- | ---------------------------------------- |
| nothing grouped           | 0.4 ms                                   |
| **90% grouped (mid-run)** | **19.4 ms**, unyieldable, once per batch |

It gets worse as the run progresses — the scan has to step over more grouped
rows to find 500 ungrouped ones. Nobody has named this; it is not in any issue.
`ungroupedFaceCount` on a fresh library: **125 ms**.

### M10 — Two unyielded blocks inside the "yielding" function

|                                                                                   |                                                            |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `personCentroidVectors` (`faceGrouping.js:60`), 6,000 people / 171k grouped faces | **571 ms**, no yield, runs _before_ the loop's first yield |
| `clusterLeftovers(500)` (`faceGrouping.js:277`)                                   | **44.8 ms** per batch, no yield **and no abort check**     |

Both are documented as deliberate. `clusterLeftovers`' comment says importing
yield machinery "for a 500-item loop would be more moving parts than the job
needs" — it is O(500²) = 124,750 dot products, and it is a third of a frame
budget, every batch. And on a library with **no people yet** — which is exactly
"group faces in the whole library" — `sinceYield += centroids.length` adds
**zero**, so the inner yield never fires at all on the first batches.

### M11 — `whenIdle()` does not yield

`server/lib/interactive.js:44` returns `Promise.resolve()` when nothing
interactive is in flight. `await` on a resolved promise is a **microtask**.

```
await whenIdle():        10,961,949 awaits in 500 ms → macrotask timer fired      0 times
await setImmediate:          37,717 awaits in 500 ms → macrotask timer fired    500 times
```

`runSweep` gets away with it because `process()` does real I/O. **`groupNearDupes`
does not**: `server/ml/nearDupeSweep.js:118`'s `await idle()` every `CHUNK = 2000`
rows is its _only_ yield in a whole-library complete-linkage pass. On an idle
server that loop **never returns to the event loop at all.** Same shape in
`server/db/places.js:90`. Neither has been measured. That is a #231 waiting to
be filed.

### M12 — Two connections: the trap, and the actual behaviour

A worker writing while the main thread reads and writes, WAL, same file:

| worker transaction                                                | result                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `db.transaction(fn)()` — **DEFERRED, the better-sqlite3 default** | **fails with `SQLITE_BUSY_SNAPSHOT`.** `busy_timeout` does not help; it is not a wait, it is a stale snapshot |
| `db.transaction(fn).immediate()`                                  | succeeds, 2,403 ms                                                                                            |

And during that 2,403 ms transaction:

| main thread |                                                               |
| ----------- | ------------------------------------------------------------- |
| **reads**   | p50 0.02 ms, p99 0.1 ms, **max 0 ms — completely unaffected** |
| **writes**  | p50 0.02 ms, **max 2,314 ms**                                 |

Chunked at 1,000 rows per transaction: worst lock hold **2,403 → 89 ms**, main
write max **2,314 → 571 ms**, and the whole reset got **faster** (1,875 ms vs
2,403 ms).

### M13 — Electron packaging: the one link nothing covered

A `worker_threads` isolate started from **inside `app.asar`** resolved
`better-sqlite3` to
`app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`
and `dlopen`'d it. The only failure was the expected ABI mismatch (my tree is
built for Node 137; Electron 43 wants 148) — **which proves the path link
works**, because a broken redirect fails as `MODULE_NOT_FOUND`, not as
`NODE_MODULE_VERSION`. Verified darwin/arm64, Electron 43.2.0.

#203 verified an ESM entry in a _spawned_ child; #232 verified a worker with
_no native addon_ (`server/projection/worker.js:16` makes "never touches
SQLite" an explicit invariant). Neither covers a native addon in a worker. This
does. It is the load-bearing packaging assumption of §7 and it holds.

---

## 3. What is actually wrong

### A — Saturation, not blocking

After #231, no single slice exceeds ~90 ms. The loop is nevertheless busy 98.7%
of the time (M2), so an HTTP request costs ~81 ms **per event-loop turn it
needs**, and a request needs several. That is why `/api/health` — a handler
with no DB work, written to be trivial precisely so it stays answerable
(`server/index.js:47`) — costs 210 ms (M3).

This is fixable by tuning (M5) and better fixed by moving the work (M4). It is
**not** the thing that produces John's banner on my fixture.

### B — Work with no yield point

This is the category the fixes have never touched, and it is where #281 lives.
The census (below, abridged) is not short:

| Where                                    | What                                                                 | Bound                                          | On an HTTP path?                                        |
| ---------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| `cacheStats.js:109` `clearCache`         | `statSync` + `unlinkSync` per file                                   | cache size (up to 5×photos)                    | **yes** — `/api/cache/clear` _and_ `/api/library/reset` |
| `cacheStats.js:128` `pruneOrphanedCache` | all-photo `.all()` + `n×5` SHA-1 + full-dir stat/unlink              | photos                                         | **yes**                                                 |
| `cacheStats.js:14` `getCacheStats`       | `statSync` per cached file                                           | cache size                                     | **yes**                                                 |
| `db/photos.js:375` `resetLibrary`        | 7 unqualified `DELETE`s, one transaction                             | library                                        | **yes**                                                 |
| `ml/faceAssign.js:52` `assignNewFaces`   | faces × named people × 64 × 512 dots                                 | the largest unyielded numeric loop in the tree | after every face sweep                                  |
| `ml/textSearch.js:102,129`               | whole `photo_embeddings` + n×dim dots + **two full sorts**           | photos                                         | **yes** — `/api/ml/search` before `res.json`            |
| `db/personCentroids.js:83`               | every grouped face × dim                                             | faces                                          | **yes** — `/api/projections/options` before `res.json`  |
| `lib/place.js:76` `build()`              | ~138,000 gazetteer rows, ~1 s, ~80 MB                                | fixed                                          | **yes** — lazily, from `/api/meta`                      |
| `lib/subdirs.js:35` `subtreeTotal`       | O(dirs²) string compares (1,183 dirs → 1.4M)                         | folders                                        | **yes** — `/api/fs/subdirs`                             |
| `db/personMerge.js:227` `undoMerge`      | `JSON.parse` up to 250k entries + one UPDATE each, one transaction   | selection                                      | **yes**                                                 |
| `index.js:43`                            | `express.json({ limit: "50mb" })` — synchronous parse of up to 50 MB | request body                                   | **every POST**                                          |

None of these can be fixed by a yield budget. Several cannot be fixed by
`setImmediate` either — you cannot yield inside `unlinkSync`, inside a
better-sqlite3 statement, or inside `Array.prototype.sort`.

**This is the category that produces #281's banner**, and M7 says it does so
with room to spare.

### C — The scheduler is unreachable

#257 built a priority queue that does what John asked for. It is tested. **It
cannot be reached.**

- `POST /api/ml/faces` returns **409** if `isClusterInFlight()`
  (`server/api.js:1732`) — before `scheduler.submit` is ever called.
- `faceSweep.js`, `embedSweep.js` and `withClusterLatch` each keep an
  `inFlight` boolean that returns `alreadyRunning` immediately.
- Phase 2's own plan (design §5) said "the six `inFlight` latches become
  assertions or are deleted". They were not. Every one is still there, along
  with eleven hand-written 409s.

So the shipped answer to "pause the big one and run mine" is: **the button
appears to do nothing.** That is _not_ an event-loop bug, and no amount of
yielding will change it.

Worse, the scheduler it would reach **has no mutual exclusion**.
`server/pipeline/scheduler.js:73` parks only on `other.priority < run.priority`.
Two runs of _equal_ priority both find nothing strictly higher and both
proceed. The design's headline rules — "exactly one runnable at a time"
(§3.3:471) and "equal priority does not preempt — FIFO" (§3.3:477) — are stated
in the module's own doc comment (`scheduler.js:29-38`) and implemented by
nothing. `#live` is an unordered `Set`.

Three more contract-2 failures shipped alongside it:

- **A paused job cannot be cancelled from the UI.** `registry.cancel` was
  correctly fixed to accept `paused` (`server/jobs/registry.js:134`) — the
  **route** was not: `server/api.js:987` still `409`s anything whose status is
  not `"running"`.
- **A parked job can be dismissed**, deleting its row while the closure keeps
  running (`registry.js:151`). The comment there predicted this exact case and
  deferred it to "the phase that introduces it". That phase shipped.
- **A parked run holds its resources.** `server/api.js:1849` builds the
  ~200 MB face engine _before_ `scheduler.submit` at `:1856`, releasing only in
  the route's `finally`. Design §3.3:483 says in bold: "The parked run holds no
  resources." There is no ref-counted holder in `scheduler.js` at all.

### D — The client lies, and nobody filed it

`ui/src/lib/serverHealth.js` has exactly one signal: a 4,000 ms
`AbortController` on `/api/health`. On timeout it renders:

> "Lost the connection to the AutoGallery server. Photos, ratings and jobs
> can't be loaded or saved right now — what's on screen may be out of date."

**Every clause of that is false** in all three of John's reports. The server is
up, the data is current, and nothing was lost. The app is telling the user it is
broken when it is working, which is worse than saying nothing — and it is the
single sentence John quotes in all three issues. Fixing A, B and C makes this
rarer; it does not make it true.

### Bonus: a hang nobody has hit yet (reasoned, not reproduced)

`app.get("/api/video/:id/file", interactiveRoute, …)` (`server/api.js:2900`)
streams for as long as the client holds the connection, and `interactiveRoute`
only releases on `close`. So **while a video is open in the loupe,
`inFlight ≥ 1` forever**, and every `await whenIdle()` in the process parks
indefinitely — `runSweep`, `groupNearDupes`, `backfillPlaces`. The JobsPanel
would show a "running" job whose bar never moves, with nothing anywhere
reporting why. I did not reproduce this. The code path is plain enough that I
would bet on it, but treat it as a hypothesis with a cheap test.

---

## 4. Why the fixes keep failing

Not carelessness. Three structural reasons.

**1. The fixes were aimed at A, and A is the least damaging of the three.**
#231's fix was correct, and it worked: 10,343 ms → 87 ms (M2), a 119×
improvement on the metric the issue defined. #279 was then filed as a
recurrence. It is not one — it is A (partly fixed), plus C (never fixed), plus
a latency that is still 11× idle. The issue thread contains no post-fix
measurement, only "John is still seeing the freeze". **A fix confirmed by "the
banner is gone" and disconfirmed by "it still feels slow" was never being
evaluated.**

**2. Every fix has been a magic constant, and no test constrains any of them.**

`YIELD_EVERY = 512` · `YIELD_PAIRS = 100_000` · `YIELD_COMPARISONS = 200_000` ·
`CHUNK = 5000` · `CHUNK = 2000` · `GROUP_BATCH = 500` · `COHORT_MS = 20_000`

Seven tunables. **Zero of them are asserted against a time budget anywhere.**
The one test that exists (`faceClusters.test.js:367`) proves the loop honours
an _injected_ budget — it would pass at any shipped value. And a constant that
is right on a 5,000-face library is wrong on a 190,000-face one, because the
work per unit is not constant: `sinceYield += centroids.length` means the
granularity of the grouping yield is _one face_, which at 25,758 people is
25,758 comparisons ≈ 12 ms whether you asked for it or not.

**3. The yield primitive most of the codebase reaches for does not yield.**
M11. `await idle()` looks like a yield, is named like a yield, is documented as
a yield, and on an idle server is a no-op. Three modules use it as their only
yield.

---

## 5. Grilling the previous agent's four claims

### Claim 1 — "four bugs are one root cause, defended only by cooperative yielding"

**Half right, and the wrong half is the expensive one.** §0 and §3. The venue
is shared; the cause is not. #281 has no loop to tune. #257/#279-part-1 is a
refusal latch. Collapsing them is precisely the move that produced three fixes
each addressing a third of the problem.

"Defended **only** by cooperative yielding" is also false as written. The repo
already contains the other defence and applied it correctly once:
`server/projection/worker.js:4-20` moves a **14.1-second unyieldable**
`umap.initializeFit` into a worker thread and says why, in the exact terms this
review would use — _"a worker gives three things by construction rather than by
discipline"_. The answer was found, written down, and not generalised.

### Claim 2 — "half-migrated, and migrated the wrong half"

**Right, and understated.** Two things went out of process — ONNX inference
(`OnnxMLService`, a spawned child) and the projection (a worker). What stayed:
every JS-side vector loop, every cascading DELETE, every syscall-per-file loop,
every whole-table `.all()`, every full sort.

The pattern is worth naming, because it will repeat: **the two things that
moved are the two that had a natural boundary already** — a model session with
its own protocol, and a pure numeric kernel that touches no state. The
selection criterion has been _"is there an obvious seam"_, never _"does this
block"_. `clearCache` has no seam and 8.4 seconds (M7); it is still on the loop.

### Claim 3 — "a worker thread would convert 'remember to yield' from discipline into structure"

**True, measured (M4), and the phrasing hides the hard part.**

A worker converts _the loops you move_. It converts nothing about the loops you
do not, and the census in §3B is long. The structural claim only becomes real
when the boundary is **enforced** rather than observed — see §9, and note that
the enforcement mechanism (a read-only main-thread connection) is a _different_
change from moving any particular loop.

It is also not free, and the claim did not say so: a worker means a second
connection, and a second connection means **`SQLITE_BUSY_SNAPSHOT`** (M12) —
which `db.transaction()`'s DEFERRED default walks straight into. Shipping "put
it in a worker" without `.immediate()` and a single-writer rule trades a
latency bug for a data bug.

### Claim 4 — "SQLite writers serialize, so a worker fixes CPU starvation but NOT write-lock stalls"

**The mechanism is right; the conclusion is wrong in the way that matters, and
the measurement was never taken.**

M12: during a **2,403 ms** write transaction on a second connection,
main-thread **reads were completely unaffected — p50 0.02 ms, max 0 ms**. Under
WAL, readers never block on a writer. And the app's interactive surface is
reads: feed, tree, thumb, preview, image, meta, health. The only interactive
_write_ is a rating.

So a worker does not "fail to fix write-lock stalls". It **shrinks the
population that stalls from everything to writers**, which is a categorical
change, not a wash. On the main loop that same 2.4 s transaction blocks reads,
writes, health, the SSE stream and every timer.

And "a huge transaction needs batching regardless" understates its own case:
batching at 1,000 rows cut the worst lock hold **2,403 → 89 ms** and made the
whole operation **faster** (1,875 vs 2,403 ms). The claim's real content should
have been **single writer** — if every write goes through one connection there
is no lock contention left to stall.

### The constraint the previous agent kept invoking

> _"better-sqlite3 is synchronous"_

**Load-bearing for the thread it runs on, and for nothing else.** Once the work
is on a worker, synchronous is a _feature_: no interleaving, no partially
applied transactions, and (M12) reads on the other thread are untouched. The
design doc itself **depends** on the synchrony for correctness (§2.2:355 — "a
synchronous Express handler that fills the table and reads its counts cannot be
interleaved by another request"). Swapping in an async driver would delete that
argument and rewrite every call site to buy nothing a worker does not already
give. See §8.

---

## 6. Grilling the design doc

`docs/superpowers/specs/2026-07-31-unified-scan-pipeline-design.md` reasons
carefully inside a model it never examines.

**Its execution model is the HTTP event loop, cooperatively yielded, throughout.**
§3.1:421 is the load-bearing sentence:

> "True suspend/resume needs either a saved cursor … or a coroutine boundary.
> **`runSweep` already HAS the boundary**: the top of its loop… Preemption is
> one more `await` at that exact point and nowhere else."

That is true, and it is the trap. Because preemption _looked_ like one line,
the question "what runs where" never got asked. §3.3:472 lists the contended
resources by name — "CPU, the ONNX worker, libvips and the same 16-slot libuv
pool" — and then manages **none of them**. A design that names the contention
and implements an _ordering_ with no _lease_ has described a scheduler and
built a suggestion.

What shipped versus what was designed (verified against the tree):

|                                                                    |                                                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Priority queue, `key` coalescing, `onPause`/`onResume`             | ✅ shipped                                                                               |
| "Exactly one runnable at a time" (§3.3:471)                        | ❌ not implemented — equal priorities run concurrently                                   |
| "Equal priority does not preempt — FIFO" (§3.3:477)                | ❌ not implemented — `#live` is an unordered `Set`                                       |
| "The parked run holds no resources" (§3.3:483)                     | ❌ the face engine is built before `submit` (`api.js:1849`)                              |
| Ref-counted resource holder owned by the scheduler                 | ❌ absent entirely                                                                       |
| "The six `inFlight` latches become assertions or are deleted" (§5) | ❌ all six still there, plus eleven 409s                                                 |
| "Hand-written 409s become queueing" (§5)                           | ❌ still refusals                                                                        |
| `cancel(id)` must accept `paused` (§4.4.1:564)                     | ⚠️ fixed in the registry, **not in the route**                                           |
| Pipeline runner with faces + embed + grouping per cohort (§1.3)    | ⚠️ only `meta` and `hash` wired; no `group` stage; `/api/scan` still calls the old kicks |
| `pipeline_scope` TEMP TABLE instead of inlined ids (§2.2:352)      | ❌ ids still inlined via `scopeClauseFor`                                                |
| Coverage response shape (§2.3)                                     | ⚠️ truncated, and **no client consumes it**                                              |

**The deepest criticism is not any single gap.** It is that the doc's central
premise — that `runSweep`'s loop top is a sufficient boundary — is _locally_
true and _globally_ false, and being locally true is what stopped anyone
checking. `groupRemaining` is mentioned in §1.3 only via a monotone-SQL
resumability argument; the doc never notices that it is a synchronous O(n·k) JS
loop, which is the #231 failure mode it was written in the shadow of.

---

## 7. What should change

**One sentence: give the server one job — answering requests — and put every
unit of work that can exceed a frame budget on a worker, behind a single
writer.**

Four structural pieces. They are independent enough to land separately.

### 7.1 A worker **pool**, generalised from the one that already works

`server/projection/runProjection.js` is the template: spawn, stream
`phase`/`progress`, cancel by `terminate()`, `resourceLimits` to turn an OOM
into a catchable job failure rather than a process death, settle exactly once.
Generalise it into `server/workers/` — do **not** copy it per feature; six
hand-copies of the feed-window guard is this repo's own cautionary tale
(CLAUDE.md, #35/#36/#39).

Pool size `min(4, cores - 2)`. The parent stays a supervisor and nothing else.

### 7.2 One writer, and it is a worker

Every write — sweeps, grouping, reset, materialize, ratings — goes through
**one** connection on **one** worker thread. This is the piece that makes M12 a
non-issue instead of a new hazard: with a single writer there is no lock
contention to serialize, and `SQLITE_BUSY_SNAPSHOT` cannot arise.

The main process keeps a **read-only** connection
(`new Database(file, { readonly: true })`). That is the enforcement mechanism,
not a convention (§9). Interactive writes — a rating — become a message to the
writer; they are single-row and will land in well under a frame.

### 7.3 Every transaction `.immediate()`, every bulk transaction chunked

M12. `db.transaction(fn)()` is DEFERRED and **fails** under concurrency;
`.immediate()` does not. Cap rows per transaction (1,000 was the sweet spot:
89 ms worst hold, and _faster_ overall). Applies to `resetLibrary`,
`saveClusters`, `replaceNeighborSim`, `mergePersonsBulk`, `undoMerge`,
`setKeepScope`, `deletePhotosByIds`.

### 7.4 The scheduler owns a lease, and the latches go

Give `Scheduler` a real running slot (a semaphore of 1 per resource class:
`onnx`, `db-write`, `vips`) acquired after `checkpoint()` and released on park.
Then delete the six `inFlight` booleans and convert the eleven 409s to
queueing. This is Phase 2 of the design, finished.

### What I would **not** do

- **Not DuckDB.** §8.
- **Not an async SQLite driver.** §8.
- **Not a separate service process.** You pay IPC serialization on every row
  and gain a second process to supervise, package, auto-update and crash. The
  only thing it buys over a worker is a separate heap, which `resourceLimits`
  already gives you (`runProjection.js:22`). The ONNX child is a separate
  process for a _real_ reason: a 200 MB native session with its own execution-
  provider selection and its own crash modes. Vector math and DELETEs have no
  such reason.
- **Not a different runtime.** Nothing here is a Node limitation. 1,125 Mmac/s
  on int8 dot products in plain JS (M1) is within a small factor of a naive C
  loop. The kernel is not the problem; the venue is.
- **Not an ANN index — yet.** It is the right long-term answer to
  190,000 × 25,758 comparisons (that is 4.9 **billion** 512-d dot products, and
  it is an _algorithm_ problem, not a scheduling one). `hnswlib-node` or
  `usearch` turns O(n·k) into O(n log k). **File it separately and do not
  bundle it with this work** — it changes grouping _results_, and mixing a
  correctness change into a latency fix is how you lose the ability to tell
  which one broke something.

---

## 8. Does the storage engine change the answer?

**No, and here is why — with the specific reasons, not a shrug.**

**DuckDB.** Wrong shape of engine for this workload, twice over.

1. The feed's speed thesis rests on **generated expression indexes** in
   `server/db/sort.js`, protected by `queryPlan.test.js` because they "rot
   silently" (AGENT-NOTES). DuckDB has no equivalent; it is a scan-and-vectorize
   engine that wins on analytic aggregates and loses on the point lookups and
   keyset-paginated windows this app is made of.
2. **It does not address the problem.** A DuckDB query on the main loop blocks
   the main loop exactly as a SQLite one does. The bug is _where the work runs_,
   not _what runs it_. Changing engines to fix a scheduling problem is the most
   expensive possible way to not fix it.

The one place DuckDB's column store would genuinely win — scanning 190,000 ×
512 int8 vectors — is better served by not scanning at all (an ANN index), and
that is available without touching the engine.

**An async SQLite driver** (`node:sqlite`'s async surface, `libsql`, `sql.js`).
Moves the blocking off the calling stack, and costs:

- every query site becomes `async` — hundreds of them across `server/db/`;
- every transaction becomes interleavable, which **deletes** the correctness
  argument the design doc leans on (§2.2:355) and re-opens every read-modify-
  write in the tree;
- and it buys, over a worker, **nothing that I measured**. M4 already gives
  0 ms health latency with the synchronous driver.

**WASM.** Solves nothing here; the native addon already loads correctly from an
asar (M13), and WASM would be slower at both SQLite and the dot products.

**Verdict: keep SQLite, keep better-sqlite3, keep the synchronous API.** Its
synchrony stops being a liability the moment it stops sharing a thread with the
HTTP server — and becomes an asset, because a single-threaded writer with
serialized transactions is the simplest correct concurrency model available.

---

## 9. The invariant, enforced by a test rather than by memory

"Remember to yield" has failed three times because **it is not checkable**, and
the one test that looks like it checks it (M0/§0) checks the mechanism, not the
number. Four tests, in increasing order of how much they'd have prevented:

**T1 — a time budget, not a comparison budget.** A helper
`expectNoBlockOver(ms, fn)` that runs `fn` against a 5 ms interval timer and
asserts worst lateness. Apply it to the **shipped constants**, not to injected
ones:

```js
it("holds the loop for under 20 ms at a time at 190k faces", async () => {
  await expectNoBlockOver(20, () => groupRemaining(db, model)); // no yieldEvery override
});
```

Revert #231's fix → red. That is the test #231's acceptance criterion asked for
("a test asserts the bound holds at a realistic n") and is not what shipped.

**T2 — the main process's DB handle is read-only.** One test:

```js
expect(() => getDb().prepare("INSERT INTO tags …").run()).toThrow(
  /SQLITE_READONLY/
);
```

**This is the only one that a developer cannot forget**, because it does not
depend on them writing a test for their new loop. A future feature that writes
on the main thread fails at the first test run rather than at the first 125k
library. It is the _end state_ of the migration, not its starting point — see
§10 step 4.

**T3 — every route answers within a budget.** Fire the whole route table
against a large fixture, assert p99 < 200 ms, with an **explicit allowlist** of
exemptions each carrying an issue number. A new route with no thought given
goes red. This is the test that would have caught #281 before it was filed:
`POST /api/library/reset` would have taken 9.7 s in CI.

**T4 — packaging.** Extend `server/ml/asarPackaging.test.js` with the
better-sqlite3-in-a-worker probe from M13, so the `app.asar.unpacked` redirect
cannot rot silently. It is ~40 lines and mirrors the existing #232 probe.

**None of these are new categories for this repo.** `queryPlan.test.js` already
guards an index against silent rot; this is the same idea applied to latency.

---

## 10. The UX half

### What the user should see while heavy work runs

1. **Stop saying "lost the connection" when the server is busy.** `/api/health`
   should carry a cheap busy signal — event-loop lag and the active job count —
   and the client should distinguish **healthy / busy / unreachable**. The rule:
   _if `/api/health` ever answers, the connection was never lost._ A timeout on
   a server that is provably still serving should degrade to "AutoGallery is
   busy — grouping 190,000 faces" **with a link to the job**, not to a claim
   that the data on screen is stale. This is a small change and it is the
   single sentence John quotes in all three issues.
2. **Reset is a job**, per #281 — and its summary must name what went:
   "Cleared 125,431 photos and 1.5 GB of thumbnails." Pressing Reset while a
   reset runs is refused _specifically_, never queued into a double wipe.
3. **Fix the three contract-2 one-liners** before anything structural: the
   cancel **route** must accept `paused` (`api.js:987`), `dismiss` must refuse a
   genuinely parked run (`registry.js:151`), and the pause reason must name the
   blocker rather than saying "waiting".

### The right interaction model for "pause the big one, run mine, resume"

The design already chose correctly: **priority by attention** — what you are
looking at jumps the queue, and the user manages nothing. Keep that. What it
needs to become real:

4. **Make the preemption visible.** The background job's row says
   _"Paused — your folder scan is running first"_, and every other row offers
   **"Run this first"**. The difference between a queue and a mystery is
   whether the reason is written on the row.
5. **Turn every refusal into a queue entry.** _"Faces are being grouped into
   people right now… starting a scan would throw the grouping away"_
   (`api.js:1734`) tells the user about an implementation detail and offers them
   nothing to do. It should become "Queued behind Grouping faces (2 minutes
   left)" with a Run-first button. Eleven of these exist.
6. **Be honest about indefinite parking.** A background run parked for ten
   minutes because scoped requests keep arriving is _correct_, and reads as a
   hang. Say "Waiting for 3 jobs" with the count — the design already argued
   this (§3.3, "starvation is real and must be visible") and nothing implements
   it.

One thing I would push back on in the ask itself:

> "The whole pipeline MUST run in the background, fast, but without affecting
> the UI."

On one core those three are not simultaneously satisfiable, and M5 shows the
exchange rate: 100× smaller yield budget buys 40× better latency and costs 35%
throughput. On 14 cores they are all satisfiable, which is the real argument for
§7. The honest offer is: **never affects the UI, and as fast as the idle cores
allow** — which on this machine is _faster_ than today (M4: 533 vs 500 faces/s
while serving 67× the traffic).

---

## 11. Migration

Ordered by damage-per-line, and every step is reversible until step 4.

**Step 0 — today, hours, fully reversible: retune, and measure.**
`YIELD_COMPARISONS` 200,000 → **2,000** (M5). Add a yield + abort check to
`clusterLeftovers` and `personCentroidVectors` (M10). Replace `await idle()`
with `await idle(); await breathe()` wherever `idle()` is the only yield —
`nearDupeSweep.js:118` and `places.js:90` most urgently (M11). Add **T1**.

⚠️ **One subtlety that will bite:** `sinceYield += centroids.length` means the
grouping yield's granularity is **one face**. At 25,758 people that is 25,758
comparisons ≈ 12 ms whether you asked for 2,000 or not. To honour a 2,000
budget you must be able to yield _mid-face_ — chunk the centroid list inside
`bestPerson`, or restructure to face-batch × centroid-chunk. Setting the
constant alone will look like it worked on a small library and do nothing on
John's.

**Step 1 — a day, reversible: the three contract-2 one-liners.** §10.3.
Independent of everything else, and each is a shipped promise currently broken.

**Step 2 — a day, reversible, no worker needed: make `/api/library/reset` and
`/api/cache/*` jobs.** Chunk the DB wipe with `.immediate()`; batch the cache
clear with real yields and progress. Still on the main loop. **This alone kills
#281's 8.4–42 s block** (M7/M8/M12) and it is the highest damage-per-line change
in this document. Do it **before** the worker, because it does not depend on
the worker existing.

**Step 3 — a week: the writer worker.** Move `groupRemaining` **first** — it
has the most evidence (M4), it already takes `checkpoint`/`signal`, and it
touches exactly two query functions. Then the sweeps, then reset. Keep the
main-thread path behind a flag until a full 125k grouping has run through the
worker path end to end. Land **T4** with the first worker.

**Step 4 — the read-only main connection (T2).** This is the acceptance test for
step 3 and the **point of no return**. Do not attempt it until every writer has
moved.

**Step 5 — the scheduler gets a lease, and the latches are deleted.** §7.4.
Phase 2, finished.

### What I would not do

- **Do not do steps 3–5 in one PR.** #155's own rule — "do the registry first
  and alone" — applies verbatim, and its stated exception (a registry with no
  switcher cannot be exercised) does not apply here: a writer worker with one
  client is fully exercisable.
- **Do not tune another constant without a test that fails when it is wrong.**
  That is exactly what got us here, three times.
- **Do not replace the storage engine.** §8.
- **Do not move the ONNX/faces boundary further.** That half is correct.
- **Do not build a second scheduler.** Fix the one that exists.
- **Do not bundle the ANN index.** §7.

---

## 12. What I did not verify, and where I could be wrong

Listed because a review that hides its gaps is worth less than one that names
them.

- **Everything is synthetic.** I never touched John's library. My fixture has
  one person per 38 faces; his reportedly has one per two
  (`runProjection.js:19`). Since `bestPerson` scales with centroid count,
  **every grouping number here is a floor**, possibly a very loose one.
- **I could not reproduce John's 4-second disconnect from grouping alone**
  (M3 — worst was 289 ms). If it reproduces on his machine, the explanation is
  probably the person count, and **I would want that number measured before
  believing anyone's account of #279, including this one.**
- **The 42-second `clearCache` figure is an extrapolation**, not a measurement:
  8.42 s at 125,000 files × 5 `THUMB_BUCKETS`. I did not create 625,000 files.
- **The `whenIdle` video deadlock (§3, bonus) is reasoned, not reproduced.**
- **better-sqlite3 under the Electron ABI in a worker is proven only to the
  `dlopen` boundary** (M13). My tree's addon is Node-ABI; completing the load
  needs `npm run electron:rebuild`, which AGENT-NOTES documents as a one-way
  switch that would have broken every other measurement in this review. The
  path link is proven; the ABI half is inferred from the fact that the main
  process already loads the same file in a packaged build.
- **I did not measure the ONNX/face-detection path's own contribution** to loop
  saturation at all — only grouping, reset and the cache.
- **I did not measure the worker approach on the _sweeps_** (which do real
  file I/O and talk to the ONNX child), only on grouping. The sweeps may behave
  differently; libuv's threadpool is per-process, not per-thread, so moving a
  sweep to a worker does **not** give it more I/O parallelism — only more CPU
  parallelism. That is a real limit of §7 and I have not quantified it.
- **The M5 throughput numbers are single-run**, not averaged. The latency
  numbers are p50/p99 over hundreds of requests and are solid; the faces/s
  column should be read as ±10%.

### Method, for reproduction

Six scripts, ~40 lines each, all runnable from the repo root against a
synthetic `AUTOGALLERY_HOME`:

1. **Seed** — `applySchema` into a temp DB; 125,000 `photos` rows; 190,000
   `photo_faces` rows with 512-byte int8 `vec` blobs drawn from N unit-norm
   prototypes plus noise tuned so intra-identity cosine ≈ 0.92 (verify it —
   with pure random vectors every face becomes its own person and the benchmark
   measures nothing real).
2. **Starvation probe** — `setInterval(…, 100)` recording worst lateness; and a
   `setInterval(…, 1)` recording every gap, which is what shows saturation (M2)
   where the 100 ms probe shows only ~87 ms.
3. **Live latency** — `createApp()` on a spare port, `POST` the real route,
   then loop `fetch` with the UI's own 4,000 ms `AbortController` timeout.
4. **Worker comparison** — same, but `new Worker()` running `groupRemaining`
   with its own `new Database(file)`; WAL and `busy_timeout` pragmas set in the
   worker.
5. **Write-lock** — worker holds a big transaction while the main thread reads
   and writes on a 5 ms tick; run it once with `tx()` and once with
   `tx.immediate()`, and the DEFERRED run will fail with `SQLITE_BUSY_SNAPSHOT`.
6. **asar probe** — mirror the `worker_threads` probe in
   `server/ml/asarPackaging.test.js`, but have the worker
   `require("better-sqlite3")` from an archive packed with
   `unpack: "**/node_modules/better-sqlite3/**"`, run under the real Electron
   binary with `ELECTRON_RUN_AS_NODE=1`. `ERR_DLOPEN_FAILED` with a
   `NODE_MODULE_VERSION` message is a **pass** (the path resolved);
   `MODULE_NOT_FOUND` is a fail.

---

## 13. Answering the seven questions directly

1. **Why do fixes keep failing? Is cooperative yielding salvageable?**
   They keep failing because they all fixed A (§3), and the report is A + B + C
   - D. Yielding is **salvageable and mistuned by 100×** (M5) — and it is
     _insufficient_, because it cannot touch B, cannot be enforced by a test, and
     trades throughput for latency on one core when the machine has fourteen.
2. **Worker threads vs. a separate process vs. something else?**
   **Worker threads.** Measured (M4), packaged (M13), and precedented in this
   repo (`server/projection/worker.js`). A separate process costs IPC per row
   and buys only a separate heap, which `resourceLimits` already gives.
3. **What prevents one large write transaction stalling everything?**
   Three things, in order: **a single writer** (no contention to serialize),
   **`.immediate()`** (M12 — the DEFERRED default _fails_, it does not wait),
   and **a row cap per transaction** (1,000 → 89 ms worst hold, and _faster_
   overall). Under WAL, readers are never blocked at all.
4. **What invariant, enforceable by a test?**
   **The main process's database handle is read-only** (T2, §9). Everything
   else is a convention a future feature can forget. This one it cannot.
5. **Does the storage engine change the answer?**
   **No.** §8. Keep SQLite and the synchronous driver; its synchrony becomes an
   asset the moment it stops sharing a thread with the HTTP server.
6. **The UX half?**
   §10. Above all: **stop telling the user the connection was lost when it was
   not**, and turn eleven refusals into a queue with a reason written on each
   row.
7. **Migration: what first, what is reversible, what would you not do?**
   §11. First the retune and the reset-as-a-job (both reversible, both large
   wins, neither needs a worker). Then the writer worker, one client at a time.
   The read-only connection is the point of no return and also the acceptance
   test. Do not bundle, do not tune without a test, do not change the engine.
