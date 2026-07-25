# ML sidecar foundation + generalized idle sweep — design (#160, #169)

**Status:** approved 2026-07-25 — not implemented
**Issues:** #160 (foundation), #169 (unmount-mid-hash bug, fixed here)
**Parent design:** `2026-07-24-ml-signals-design.md` §1–§3
**Ships:** no user-visible feature except a JobsPanel entry for hashing
**Version:** 2.18.5 (patch)

## Why this slice exists

Every later ML slice — embeddings (#161), near-dupes (#162), clusters (#163),
scene tags (#164), faces (#166), people (#167) — needs two things that do not
exist: a place to run a model that is not the main event loop, and a background
sweep that actually drains. This slice builds both and adds no model.

It is deliberately scoped to leave model selection to #161, where there is a real
consumer to measure cost against. What it does **not** defer is the packaging
question, because that is the one that has already cost a release: #67 shipped a
Node-ABI `better-sqlite3` into an Electron build and crashed on launch.
`onnxruntime-node` is the second native addon in the tree and gets the same
treatment now, while nothing depends on it, rather than during a slice that also
has a model to choose and a backfill to measure.

## Problem 1: the sweep has been written twice by hand

`/api/enrich` (`server/api.js:700`) and `hashAllPending`
(`server/db/hashing.js:89`) are the same loop written independently. Both drain
until empty, both idle-gate with `whenIdle()`, both keep their worklist in SQL so
they resume after a crash, both write a failure sentinel so a poison file cannot
spin the loop forever.

They have already diverged. Enrich has a `registry` job, progress reporting,
cancellation via `job.controller.signal`, and per-file isolation on a batch
failure. `hashAllPending` has none of those — it is called fire-and-forget at
`server/api.js:631` and `:652` with `.catch(() => {})`, so it is invisible while
it runs and uncancelable.

This is the same failure mode CLAUDE.md already documents for the feed-window
guard: six hand-copied versions, two shipped bugs (#35, #36, #39). The
conclusion there was to consolidate into two named transactions. The conclusion
here is the same — extract the loop and migrate **both** callers, so the ML
sweeps are not the third and fourth copy.

## Problem 2: #169, the bug the shared version would not have shipped

`hashPendingPhotos` (`server/db/hashing.js:32`) has a bare `catch` that marks the
row `hash_attempted = 1`. It cannot tell "this file is corrupt" from "this volume
went away".

`upsertScan` only clears that marker when size **or** mtime changed
(`server/db/photos.js:47-51`). An unmount changes neither. So:

1. Drive unmounts mid-sweep → every remaining file fails to open → all marked.
2. Drive returns, files byte-identical, rescan reports the identical stat → the
   marker survives.
3. `hashPendingPhotos` selects `WHERE content_hash IS NULL AND hash_attempted = 0`
   (`server/db/hashing.js:37`) → those rows are invisible to it, permanently.

Unmounting is routine for this app — invariant 2 is built around browsing with
the drive detached — and the failure is silent: backup-coverage and dedup just
under-report. That is the same class of wrongness #168 set out to fix. It
affects #12, #86, #129, and #162, all of which assume the hash set is complete.

## Design

### `server/ml/sweep.js` — one drain

```js
runSweep(job, {
  nextBatch, // () => rows[]         re-queried from a SQL partial index
  process, // (rows) => Promise<number written>
  markFailed, // (row, err) => void   the caller's OWN sentinel write
  folderOf, // (row) => string      folder abs_path, for the reachability probe
  onProgress, // ({ done, failed }) => void
});
```

**The caller owns the sentinel write; `runSweep` owns the classification.**

That split is the whole design. The three sentinels are not interchangeable and
must not be unified: enrich overloads data columns (`width = 0`, `lens = ""` —
`server/db/enrich.js:13-22`), hashing uses a boolean (`hash_attempted = 1`), and
ML stages will need an explicit row because a failed embedding has no natural
zero value. So the write stays a callback.

The _classification_ — is this failure a permanent property of the photo, or a
property of the moment? — is exactly what each hand-rolled copy got to decide for
itself, and it is what `hashAllPending` got wrong. It moves into `runSweep` and
there is one answer.

`runSweep` also owns: drain-until-empty, `await whenIdle()` between batches,
`job.controller.signal`, poison-file isolation (batch failure → retry one at a
time), and progress reporting.

**Single-flight stays with the caller**, not `runSweep`. It is per _stage_, and
the two callers genuinely want different things: hashing keeps its module-level
latch (a second post-scan kick while one sweep runs must be a no-op, since both
would drain the same worklist), while enrich deliberately has none — each `POST
/api/enrich` is a user asking for a job, and two concurrent re-reads of
different id sets are legitimate. Hoisting the latch into `runSweep` would
require a stage key and would impose hashing's answer on a caller that wants the
opposite.

### The failure contract

```
catch (err) on row R:
  if (!reachable(folderOf(R)))
      → ABORT the pass. Nothing is marked.
        job finishes "paused — drive not available"
  else
      → markFailed(R, err)        // permanent: deleted, or corrupt
```

`volumes(id, label, uuid, last_mount_path)` and `folders.volume_id` already exist
(`server/db/schema.js:5-18`), so "is the drive there" is answerable without new
schema. The probe is one `stat` **per failure**, not per row, so it costs nothing
on a healthy sweep.

`reachable(absPath)` stats the row's **folder** `abs_path` — not the file, whose
absence is the thing being diagnosed, and not the volume mount root, which on
macOS can remain as an empty `/Volumes/Name` directory after an eject. A folder
that is gone when its file is gone means the volume went away; a folder that is
still there means the file specifically was removed.

**Why abort rather than skip.** `nextBatch()` re-queries SQL on every pass — that
is load-bearing, because it is what makes the worklist crash-safe and
resumable. So a transient failure that marks nothing will be handed back
immediately and the loop spins forever. Two ways out: a pass-local skip set, or
abort the pass. Abort is correct here because a missing volume means _nothing_
in that folder is processable — continuing would burn through the whole backlog
re-failing every row. The next post-scan kick resumes from SQL with no
bookkeeping.

**Why ENOENT-with-volume-present is permanent.** If the drive is mounted and the
file is still not there, the file is genuinely gone. Absence is already owned by
the stale/`classifyMissing` machinery (`server/db/missing.js`); the sweep should
not develop a second opinion about it.

### The two migrations

**Enrich** keeps its behaviour exactly. Its loop at `server/api.js:700` becomes a
`runSweep` call whose `markFailed` is the existing `writeMeta(db, p.id, {})`.
Existing e2e specs must stay green and unmodified — if a spec needs changing, the
extraction changed behaviour and is wrong.

**Hashing** loses its hand-rolled loop and gains what enrich already had:

- `markFailed` = the existing `hash_attempted = 1` write. **The column keeps its
  current meaning** — no migration, no attempts counter.
- A `registry.create("hash", …)` job, so it has progress and a cancel button.
  This needs a `job.type === "hash"` summary branch in `JobsPanel.svelte`
  (alongside the existing `materialize`/`export`/`scan`/`undo-move`/`enrich`/
  `transcode` branches at `:136-169`). This is the only user-visible change in
  the slice, and it is the "never fail silently" position: hours of full-file
  SHA-1 on a 114k library should not be invisible.
- The `#169` classification, for free.

Note the asymmetry between the two migrations: enrich's tests must not change
(they pin behaviour that is being preserved), but `server/db/hashing.test.js`
**will** change, because `hashPendingPhotos`' hand-rolled batch loop is what is
being deleted. Its per-batch cases move to `runSweep`'s tests; the cases that
assert hashing _outcomes_ stay where they are.

### Repairing libraries already poisoned

Fixing the code forward does **not** un-mark rows already marked on 2.17.14 →
2.18.4. Those photos stay invisible to the hasher forever, which is the entire
harm of #169. So the slice includes a one-time repair at schema-migration time:

```sql
UPDATE photos SET hash_attempted = 0
 WHERE hash_attempted = 1 AND content_hash IS NULL AND stale = 0;
```

Safe by construction: a genuinely unreadable file is re-attempted once and
re-marked. The cost is one wasted pass over a handful of corrupt files; the
benefit is that anyone who unmounted mid-sweep gets their library back.

**It must run exactly once, and `applySchema` has no mechanism for that.** Every
other step there is idempotent by construction — `CREATE TABLE IF NOT EXISTS`,
`ensureColumn` — and `applySchema` runs on every startup. A data `UPDATE` is not
idempotent in that sense: re-running it each launch would also clear the marks
the _fixed_ code sets on genuinely corrupt files, so those would be re-attempted
on every startup forever. That is precisely the spin the sentinel exists to
prevent, reintroduced by the repair for it.

So the repair is gated on `PRAGMA user_version` — SQLite's built-in one-shot
migration counter, zero schema cost, and the first use of it in this codebase:

```js
// server/db/schema.js, inside applySchema
const v = db.pragma("user_version", { simple: true });
if (v < 1) {
  db.exec(`UPDATE photos SET hash_attempted = 0
            WHERE hash_attempted = 1 AND content_hash IS NULL AND stale = 0`);
  db.pragma("user_version = 1");
}
```

This establishes the pattern for every future one-shot data repair; the counter
is the app's, not SQLite's, and only ever moves forward.

### `server/ml/` — the sidecar substrate

Mirrors `server/processing/` deliberately; the codebase already knows how to read
that shape.

```
server/ml/
  MLService.js       abstract base; embedImages / embedTexts / detectFaces
                     all throw. JSDoc typedefs carry the contract.
  OnnxMLService.js   spawns and supervises the child. Does no inference.
                     `spawn` is injectable so supervision is testable.
  worker/index.js    the child. JSON-lines over stdio, one request at a time.
                     This slice handles exactly one op:
                       { op: "health" } → { ort, providers, pid }
  sweep.js           runSweep (above)
```

**Out of process is not optional.** In-process inference would contend for the
same 16-slot libuv threadpool `server/index.js:19` reserves for libvips — the
failure already measured and documented in `server/lib/interactive.js:1-17`
(thumbnails 15 ms → 90 ms under a sweep, tiles abandoned mid-scroll). And a
native-addon segfault would take the whole app down. The child process _is_ the
resilience requirement: hard resource boundary, kill switch, crash isolation,
respawn with backoff.

**No model, no `transformers.js`, no inference in this slice.** The worker loads
`onnxruntime-node` and reports its version and available providers. That is
enough to prove the runtime starts under both Node and a packaged Electron build,
which is the question worth answering now.

### Packaging

`onnxruntime-node` gets the treatment `better-sqlite3` already has:

- `asarUnpack` (`package.json:88`) += `node_modules/onnxruntime-node/**`
- `rebuild:electron` (`package.json:22`) → `electron-rebuild -f -w better-sqlite3 -w onnxruntime-node`
- `npmRebuild: false` (`package.json:71`) stays off — #67 is why.
- In a packaged build the child spawns via `ELECTRON_RUN_AS_NODE=1` on the
  Electron binary, so it runs on Electron's ABI rather than Node's.

Relates to #136 (mac arch matrix) and #94 (signing), neither of which this slice
resolves.

## Deferred, on purpose

- **`ml_status(photo_id, stage, state, attempts, error)`.** The parent design
  prescribes it, and it is still right — but with the volume-probe contract
  neither enrich nor hashing needs an attempts counter, and this slice has no
  stage that would write a row. It arrives in #161 with its first real writer.
  Shipping an unused table now would be a guess about a schema we cannot yet
  test.
- **Model selection, download UX, and `~/.autogallery/models/`** — #161, where
  there is a cost to measure.
- **`thumbCachePath` extraction** (`server/api.js` / `server/lib/cacheStats.js`
  duplicate the key formula) — #161, which is the first code that needs to read a
  thumb path from outside the API layer.

## Never fail silently

- Volume disappears mid-sweep → the job finishes as **"paused — drive not
  available"**, naming the drive, not as a silent stop and not as a failure. It
  resumes on the next scan.
- Sidecar crashes or will not start → said once, naming the stage, with a retry.
  **The app stays fully usable without ML** — nothing in this slice is on a user
  path.
- Failed photos stay countable, so "12,431 of 114,125 hashed, 37 failed" is
  reportable rather than an unexplained shortfall. This is precisely how
  pre-2.17.14 `backupCoverage` misled.
- Hashing progress and cancel go through the JobsPanel like every other job.

## Testing

A fixed bug gets a test at the tier that would have caught it.

| Tier         | Test                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| vitest, pure | `runSweep` with a fake `process` that fails a chosen row → sentinel written, loop still drains to empty                                          |
| vitest, pure | volume unreachable → pass aborts and **marks nothing**; a later pass with the volume back drains (the #169 regression)                           |
| vitest, pure | `runSweep` honours `job.controller.signal` mid-batch                                                                                             |
| vitest, db   | the `hash_attempted` recovery migration clears poisoned rows and leaves hashed/stale rows alone                                                  |
| vitest, db   | the repair runs **exactly once**: a second `applySchema` on the same db does not re-clear a mark set after the repair (`user_version` gate)      |
| vitest       | `OnnxMLService` supervision against an **injected fake spawn**: crash → respawn with backoff; kill → in-flight batch fails cleanly, app survives |
| vitest, db   | enrich still writes the same sentinel for an unreadable file after the migration                                                                 |
| e2e          | existing enrich specs green and **unmodified**                                                                                                   |

**The #169 regression test must be watched failing before the fix.** The issue
records the trap: do not re-`stat()` the restored file and feed those values to
`upsertScan` — `writeFileSync` + `utimesSync` round-trips `mtimeMs` at
sub-millisecond precision, the rescan sees a "changed" file, `hash_attempted`
resets, and the test passes for the wrong reason. A real unmount does not touch
mtime, so passing the original entry is the faithful model.

**The child-process escape hatch.** #160's acceptance says the suite never spawns
a child, which keeps CI fast and hermetic — but taken literally it means the real
worker's stdio protocol is never exercised, and "does the child start at all"
gets discovered by a user. So: the default suite uses the injected fake spawn,
and **one** integration test spawns the real child and asserts `{ op: "health" }`
round-trips, gated behind `ML_INTEGRATION=1` and off by default in CI. It is the
only test that touches `onnxruntime-node`.

## Acceptance

- [ ] Both existing sweeps run through `runSweep`; no hand-rolled background
      drain loop remains in `server/`. (The `for(;;)` at `server/api.js:2134` is
      an album-name dedup loop, not a sweep, and stays.)
- [ ] Enrich behaviour is unchanged — existing e2e specs green and unmodified.
- [ ] An unmount mid-hash marks nothing; the photos hash on a later pass. The
      regression test goes red without the fix.
- [ ] Libraries poisoned on 2.17.14–2.18.4 recover without a rebuild.
- [ ] Hashing appears in the JobsPanel with progress and a working cancel.
- [ ] The default test suite spawns no child process and downloads no model.
- [ ] Killing the child mid-sweep leaves the app usable and the job reported as
      failed, not hung.
- [ ] A packaged build launches with `onnxruntime-node` present and `{ op:
"health" }` answering.
- [ ] `CHANGELOG.md` + `package.json` bumped to 2.18.5 in the same commit.

## Out of scope

- Any model, inference, or model download (#161).
- `ml_status` and retry-with-attempts (#161).
- GPU / WebGPU execution providers.
- Anything user-facing beyond the JobsPanel entry for hashing.
