# Unified scan pipeline — design (2026-07-31)

One user-facing process: **"Scan my photos."** Everything the panel has enabled happens
to those photos, progressively, in one job, with one bar, that can be paused, preempted,
resumed, stopped, and that says what it found.

Status: **design only.** Nothing here is implemented. Written against `2.19.3`.

Tracked by the epic **#258**, with sub-issues **#257** (preemption), **#250** (faces imply
grouping), **#245** ("Visible" must mean the filter's result set), **#249** (scoped runs
must report what happened). Those were filed after this document was drafted, which is why
§8 says no duplicate search was done — it has been done since.

---

## 0. What is actually there today (verified by reading, not assumed)

| Stage | Entry point | Worklist | Batch | Latch | Job type |
|---|---|---|---|---|---|
| scan | `POST /api/scan` (`api.js:1008`) | filesystem walk | 1 dir | none | `scan` |
| metadata | `POST /api/enrich` (`api.js:1194`) | `PENDING_CONDITION` (`db/enrich.js:46`) | `BATCH` | none | `enrich` |
| hash | `kickHashSweep` (`api.js:297`) | `pendingHashRows` (`db/hashing.js:23`) | 50 | `hashingInFlight` | `hash` |
| embed | `kickEmbedSweep` (`api.js:359`) / `POST /api/ml/embed` | `pendingEmbedRows` (`db/embeddings.js:109`) | 16 | `isEmbedInFlight` | `embed` |
| faces | `POST /api/ml/faces` (`api.js:1706`) | `pendingFaceRows` (`db/faces.js:144`) | `FACE_BATCH` = 8 | `isFaceSweepInFlight` | `faces` |
| face grouping | `POST /api/ml/faces/cluster` (`api.js:1936`) | `ungroupedFaceRows` (`db/faces.js:543`) | `GROUP_BATCH` = 500 | `isClusterInFlight` | `face-cluster` |
| near-dupes | `kickNearDupeSweep` (`api.js:503`) | whole-library | — | `isNearDupeSweepInFlight` | `near-dupes` |
| projection | `POST /api/projections` | working set | — | `isProjectionInFlight` | `projection` |

Six independent single-flight latches, all module globals, none of which know about each
other. Coordination between them is currently **`409` refusals written by hand at each
route** (`api.js:1716`, `1937`, `1943`, `2072`, `2245`) plus one chained kick
(`kickEmbedSweep` → `kickNearDupeSweep` on success only, `api.js:460`).

Four facts that shape everything below:

1. **`runSweep` (`server/ml/sweep.js`) is already the right abstraction** and is not being
   replaced. It owns the drain loop, the idle gate (`whenIdle`), the abort check, poison-file
   isolation, and — the part that matters — the transient/permanent classification. Its
   termination property is that `nextBatch()` is re-queried every pass, so **the SQL worklist
   IS the resume point**. Every design decision here preserves that.
2. **The job registry is an in-memory `Map`** (`server/jobs/registry.js:22`). Jobs do not
   survive a restart. This is a feature, not a gap: since the DB is the checkpoint, a lost job
   row costs nothing.
3. **There is no `paused` job status.** `kickHashSweep` (`api.js:314`) and `kickEmbedSweep`
   (`api.js:448`) fake it with `registry.update(id, {status: "failed", error: "paused — …"})`.
   `JobsPanel.svelte:48` counts those in `broken` and renders a red `✗` with "1 failed" in the
   pill. That is the same Finding-6 mistake the panel's own comment condemns for cancellation,
   already shipped for pauses.
4. **`waitForJob` (`ui/src/lib/jobs.js:117`) resolves on any status other than `"running"`.**
   Adding a `paused` status without touching this makes every waiter think the job finished.

---

## 1. The per-photo progressive pipeline

### 1.1 The unit of work is (stage, batch) inside a cohort — not one photo

A literal per-photo pipeline is the tempting reading of the ask and it is wrong here, for
three reasons that are all visible in the code:

- **Batching is load-bearing per stage and the sizes differ by 60×.** `ml.embedImages(buffers)`
  is called with 16 buffers at once (`embedSweep.js:105`); `FACE_BATCH` is 8 because "each one
  may hold a full-resolution bitmap in the worker — this library's p90 is 20 MP, i.e. 60 MB
  decoded" (`faceSweep.js:28`); hashing does 50; enrich does `BATCH`. Carrying one photo
  through all stages destroys every one of those.
- **Sessions are expensive and per-stage.** The face engine is ~200 MB resident and is closed
  in a `finally` because it "must not outlive the sweep" (`api.js:1914`). The ML worker needs
  `ml.configure({modelId, threads, device})` before the first image.
- **`runSweep`'s termination depends on a shrinking SQL worklist.** A per-photo loop would have
  to hand-roll a different drain, which is the six-hand-copied-guards shape CLAUDE.md warns
  about.

**Decision: cohort-major, stage-minor.**

A pipeline *run* walks its scope in **cohorts** — a bounded slab of photos (default 500) —
and runs every enabled stage over that cohort before taking the next one. Inside a cohort,
each stage keeps its own batch size and its own `runSweep` call, restricted by
`scopeIds = cohortIds`.

The face engine and the ML worker are opened **once per run**, held across cohorts, and
closed in a `finally`. That removes the session-thrash objection entirely.

What the user perceives: after roughly two minutes, the first 500 photos have dates, hashes,
vectors, faces and people — and the counts for *all* stages climb together instead of
completing one at a time over an afternoon.

### 1.2 Ordering, and the real dependencies

```
scan ──> [ meta ] ──> [ hash ] ──> [ embed ] ──> [ faces ] ──> group(cohort)
             │           │            │             │
             └── EXIF    └── SHA-1    └── needs a   └── needs the ORIGINAL
                 dims                     320px        via sharp
                 GPS                      thumb
                                                              ⋮ end of run
                                              consolidate: near-dupes (whole library)
```

Verified dependency facts, several of which contradict the intuitive ordering:

- **`faces` does NOT depend on `embed`.** `createFaceEngine` reads the original file with
  `sharp`; it never touches `photo_embeddings`. They are siblings. Their order is a policy
  choice, and embed goes first only because it is roughly an order of magnitude cheaper per
  photo (`approxMsPerPhoto`), so the cheaper signal lands sooner.
- **`embed` depends on a thumbnail**, generated on demand inside the sweep by `thumbBytes`
  (`ml/thumbSource.js`). Do **not** promote that to a pipeline stage; it is already lazy and
  cached and adding a stage would double the bookkeeping for no gain.
- **`meta` and `hash` depend on nothing** and gate nothing. They go first because dates are
  what make the grid usable, and because they are the only two stages that work with no model
  downloaded at all.
- **`group` depends on `faces` for the same cohort**, and is the cross-photo case below.

### 1.3 The cross-photo tension, resolved

Two stages are cross-photo, they are cross-photo in **different** ways, and the resolutions
differ. This is the part of the design worth arguing about.

**Face grouping is already solved and the repo has not noticed.** `groupRemaining`
(`server/ml/faceGrouping.js`, #235) is:

- incremental — each batch of 500 is committed;
- resumable — the worklist is "faces with no person", so "there is no checkpoint to corrupt,
  because the DATABASE is the checkpoint";
- scoped — takes `scopeIds` like every other long operation;
- and, critically, **monotone**: `UPDATE photo_faces SET person_id = ? WHERE id = ? AND
  person_id IS NULL`. It never un-assigns. It scores each new face against a **frozen** set of
  person centroids and clusters the leftovers among themselves.

Monotone + frozen centroids is exactly the property that lets a cross-photo stage live inside
a per-cohort pipeline. Running `groupRemaining(db, model, {scopeIds: cohortIds})` after each
cohort's detection:

- does **not** re-cluster the world — it compares new faces against existing person centroids;
- costs, summed over all cohorts, **the same total comparisons** as running it once at the end
  (each face is compared against the people that exist when it is filed, either way);
- leaves nothing for the user to know about or trigger.

The honest cost of doing it incrementally rather than globally: **it is order-dependent.** A
face that would have anchored its own cluster in a global pass may instead join a
slightly-wrong person that already existed. The repair already exists and stays:
`POST /api/ml/faces/cluster {mode: "regroup"}` → `clusterFaces` + `saveClusters`, which
protects named people and manual merges (`db/faces.js:390`). So:

> **Incremental grouping by default, inside the pipeline. Global regroup stays an explicit,
> confirmed, advanced action.**

`assignNewFaces` (`ml/faceAssign.js`, named people only) stays and runs **before**
`groupRemaining` in each cohort. Both are monotone, both key on `person_id IS NULL`, so they
compose — and the ordering preserves the deliberate bias toward filing a face under someone
the user has *named* rather than under an unnamed machine guess.

**Near-duplicate grouping is not monotone and must not be per-cohort.** `groupNearDupes`
replaces the whole grouping wholesale (`replaceNearDupeGroups`), and one new photo can merge
two previously separate groups — `kickNearDupeSweep`'s own comment says "there is no
meaningful partial answer to compute while vectors are still arriving" (`api.js:493`). It is
also cheap: "seconds of arithmetic" against "72 minutes of inference".

> **Near-dupes is a GLOBAL CONSOLIDATION step that runs once, at the end of a pipeline run,
> and is skipped when the run was cancelled or when the embed stage stalled** — reusing the
> existing rule that regrouping a half-embedded library "would look like a finished answer".

That gives a three-tier vocabulary the whole design rests on, and it should be named in the
code:

| Tier | Stages | Property | Where it runs |
|---|---|---|---|
| **Per-photo** | `meta`, `hash`, `embed`, `faces` | worklist-driven, scoped, batched | inside each cohort |
| **Incremental consolidation** | `group` | cross-photo but **monotone**, frozen centroids | after each cohort |
| **Global consolidation** | `near-dupes`, face `regroup` | non-monotone, wholesale replace | once at end of run / on request |

### 1.4 The worklist query

The single most important structural rule of this design:

> **One module owns each stage's pending predicate as one SQL string, and every consumer —
> worklist, count, cohort selection — is built from that string.**

`server/pipeline/stages.js`:

```js
export const STAGES = [
  {
    id: "meta",
    label: "Reading metadata",
    eligible: "1",                       // every kind
    pending: PENDING_META,               // re-exported from db/enrich.js
    batch: META_BATCH,
    msPerPhoto: 12,                      // measured; see §4
    worklist: (db, { limit, scope }) => …,
    run: (ctx, rows) => enrichBatch(…),
    markFailed: …,
  },
  { id: "hash",  eligible: "1",                       pending: PENDING_HASH,  … },
  { id: "embed", eligible: "photos.kind != 'raw'",    pending: PENDING_EMBED, … },
  { id: "faces", eligible: "photos.kind = 'image'",   pending: PENDING_FACES, … },
];
```

with the predicates lifted verbatim from where they already live:

```sql
-- PENDING_META  (db/enrich.js:46, already shared with idx_photos_pending_meta)
photos.width IS NULL
  OR (photos.kind = 'video' AND photos.video_codec IS NULL)
  OR photos.gps_checked = 0

-- PENDING_HASH  (db/hashing.js:28)
photos.content_hash IS NULL AND photos.hash_attempted = 0

-- PENDING_EMBED (db/embeddings.js:138)
NOT EXISTS (SELECT 1 FROM photo_embeddings e
             WHERE e.photo_id = photos.id AND e.model = @model)
AND NOT EXISTS (SELECT 1 FROM ml_status s
                 WHERE s.photo_id = photos.id
                   AND s.stage = 'embed' AND s.model = @model AND s.state = 'failed')

-- PENDING_FACES (db/faces.js:166)
NOT EXISTS (SELECT 1 FROM ml_status s
             WHERE s.photo_id = photos.id
               AND s.stage = 'faces' AND s.model = @faceModel)
```

`pendingEmbedRows`, `pendingFaceRows`, `pendingMetaPhotos` and `pendingHashRows` are refactored
to build their `WHERE` from these constants. **This is Phase 0 and ships alone with zero
behaviour change**, because the alternative — a hand-copied second copy of a pending predicate
— has already cost this repo one silent full-table-scan regression (`schema.js:444`, the
`idx_photos_pending_meta` note).

**Cohort selection.** The next cohort is "the next N photos in the scope that are pending in
*any* enabled stage, by id":

```sql
SELECT photos.id
  FROM photos
  JOIN folders ON folders.id = photos.folder_id
 WHERE photos.stale = 0
   ${scopeClause}                       -- "" | AND photos.id IN (…) | JOIN pipeline_scope
   AND ( (${eligible_meta}  AND (${PENDING_META}))
      OR (${eligible_hash}  AND (${PENDING_HASH}))
      OR (${eligible_embed} AND (${PENDING_EMBED}))
      OR (${eligible_faces} AND (${PENDING_FACES})) )
 ORDER BY photos.id
 LIMIT @cohort
```

No cursor is stored. A completed cohort's photos are no longer pending in any stage, so the
next call returns the next cohort. A crash costs one cohort's *in-flight batch*, exactly as
today.

**Known cost risk, flagged rather than papered over:** this is a disjunction, and SQLite will
not use the partial `idx_photos_pending_meta` for it — `schema.js:453` already documents that
the multi-index OR optimisation does not apply to this file's index style, verified via
EXPLAIN QUERY PLAN. So this query is a full scan of `photos` (125 k rows) with correlated
index probes, executed **once per cohort** — about 250 executions for a full-library run. That
is fine if it is ~150 ms and unacceptable if it is 2 s. **Measure before shipping Phase 3.**
Two mitigations, in order of preference:

1. **Scan-derived cohorts.** For the case the user actually described — "I scan a folder" —
   the scope is a folder, `upsertScan` already returns the rows it wrote, and `photos.folder_id`
   is indexed by `UNIQUE(folder_id, filename)`. Pass `folderId`, not an id list; the OR query
   is then bounded by one folder and the risk evaporates for the common path.
2. **A composite index** `CREATE INDEX idx_photos_stale_kind_id ON photos(stale, kind, id)`
   so the eligible-set scan is an index scan. Propose it, add a `queryPlan.test.js` assertion,
   and **delete it if the plan does not change** — an index that answers no query is the kind
   of thing `perceptual_hash` was.

---

## 2. Coverage — "how many are missing"

### 2.1 The three scopes the user asked for are not the three the contract fixes

The user asked for counts in "keep only, selected, and all". `ScopeControl` today offers
**All / Visible / Selected**, and `visibleIds` is `items.map(it => it.id)` (`App.svelte:6928`)
— i.e. **the loaded feed window**, a few hundred rows, not "what the current filter matches".
Keep-only is a *server-side* filter flag (`keep_scope` table, `buildFilter`'s `keepScope`), not
an id list.

**Decision:** when a keep-only scope is in force, `ScopeControl` renders **four** options:

```
( ) Whole library (125,431)   ( ) Keep only (4,210)   ( ) Visible (312)   ( ) Selected (20)
```

With no keep-scope in force it renders today's three, unchanged. This needs a one-paragraph
amendment to `docs/UI-CONTRACTS.md` §1 in the same commit — the contract is amendable, silently
diverging from it is not. The rejected alternative (relabel `All` to "All in Keep only" and
keep three radios) is smaller but hides the whole-library number, which is precisely one of the
three the user asked to see.

### 2.2 One query shape, one endpoint, one round trip

`server/pipeline/coverage.js`:

```sql
SELECT COUNT(*) AS n
  FROM photos
  ${scopeJoin}                     -- "" | JOIN pipeline_scope s ON s.photo_id = photos.id
                                   --    | JOIN folders ON …   (the filter needs it)
 WHERE photos.stale = 0
   ${filterSql}                    -- from buildFilter(spec) — free reuse, incl. keepScope
   AND (${stage.eligible})
   AND (${stage.pending})
```

Three ways to express a scope, and all three matter:

- **library** — no join, no filter clause;
- **filter** — `buildFilter(spec)` returns `{sql, params}` (`db/filters.js:16`). This is how
  keep-only, rating, orientation, kind, person and tag filters are *already* expressed
  server-side. Keep-only coverage therefore costs nothing extra and **never ships 40,000 ids
  over the wire**;
- **ids** — an explicit selection.

**For the ids case, do not inline the literal list.** `faceSweepPending` already does
`pendingFaceRows(db, model, MAX_SAFE_INTEGER, ids)`, which for a 50,000-id scope builds a
~350 KB SQL string whose text differs on every call, so nothing is prepared-cached, and
coverage would do that four times per refresh. Instead:

```sql
CREATE TEMP TABLE IF NOT EXISTS pipeline_scope (photo_id INTEGER PRIMARY KEY);
```

filled inside one `db.transaction()`. This is safe by construction: better-sqlite3 is
synchronous, so a synchronous Express handler that fills the table and reads its counts cannot
be interleaved by another request. Every coverage statement then has fixed text and is prepared
once. `keep_scope` (`schema.js:68`) is the existing precedent for exactly this move — "an
arbitrarily large scope never has to travel in a URL query param".

### 2.3 The endpoint

```
POST /api/pipeline/coverage
{
  filter?: FilterSpec,        // the current view, incl. keepScope
  ids?: number[] | null,      // the selection; null/omitted = no selection scope
  model?: string,             // embed model  (default: ml settings)
  faceModel?: string          // face pack    (default: ml settings)
}
→ 200
{
  scopes: {
    library:  { photos, stages: { meta: {pending, done, failed}, hash: …, embed: …, faces: … },
                faces: { detected, grouped, ungrouped, people } },
    filtered: { … },          // present iff `filter` was sent
    selected: { … }           // present iff `ids` was sent
  },
  estimates: { meta: msPerPhoto, hash: …, embed: …, faces: … },
  ready: { embed: true, faces: false, facesReason: "weights not downloaded" }
}
```

**One request, every scope, every stage.** That is what makes it cheap enough to be live: the
scope radio buttons no longer each trigger a fetch, because the answer for all of them is
already in hand. Client-side debounce ~250 ms on selection change. Cost: four
`COUNT(*)`-with-anti-join over 125 k rows per scope — the `ml_status` anti-joins are served by
that table's own PK `(photo_id, stage, model)`, which `schema.js:360` documents as verified via
EXPLAIN. Estimate 50–150 ms per scope; **measure, and add `queryPlan.test.js` coverage.**

### 2.4 Two data bugs found while reading, worth fixing here

- **`faceCounts` (`db/faces.js:184`) can under-report `pending`.** Its `total` counts
  `photos WHERE stale = 0 AND kind = 'image'`, but its `scanned`/`failed` come from
  `SELECT state, COUNT(*) FROM ml_status WHERE stage = ? AND model = ?` with **no join to
  photos and no `stale = 0`**. A photo that was scanned and later went stale still counts as
  scanned, so `total - scanned - failed` can be too low (and, if enough rows go stale,
  negative). `embedCounts` (`db/embeddings.js:164`) does join and filter `p.stale = 0`, so the
  two disagree. Coverage should always use the **direct anti-join COUNT**, never the
  subtraction, and `faceSweepPending`'s unscoped branch should follow.
- **`clearEmbedFailures` (`db/embeddings.js:261`) deletes every `ml_status` row for the stage
  and model regardless of `state`**, despite the docstring saying it clears failures and
  "deliberately does NOT touch `done` rows" (that sentence is true of `clearFaceFailures`, which
  does filter `AND state = 'failed'`). Today `failed` is the only state written for `embed`, so
  it is inert — but the pipeline is exactly the kind of change that introduces a second state.
  Add the `AND state = 'failed'` before that happens.

---

## 3. Preemption

### 3.1 Decision: one priority queue over one worker, not suspend/resume

Rationale tied to this codebase:

- Six independent latches enforcing "one at a time" per stage, with no coordination and
  hand-written `409`s between them, **is** the consolidation candidate. Replacing them with one
  scheduler is the same move `runSweep` made for six hand-rolled drains and
  `withFeedTransaction` made for six hand-copied feed guards.
- True suspend/resume needs either a saved cursor (which breaks "the DB is the checkpoint") or
  a coroutine boundary. **`runSweep` already has the boundary**: the top of its loop, where it
  does `abortIfCanceled()` and `await idle()` (`sweep.js:157-162`). Preemption is one more
  `await` at that exact point and nowhere else.

### 3.2 What "pause" means, precisely

> A preempted run **finishes its current batch, commits it, and then blocks at the top of the
> drain loop** until the scheduler lets it continue. Never mid-batch.

Worst-case latency before the user's scoped work starts, by stage:

| Stage | Batch | Approx. batch wall time |
|---|---|---|
| faces | 8 | ~2.5 s (the worst case) |
| embed | 16 | ~0.6 s |
| hash | 50 | ~1 s |
| meta | `BATCH` | <1 s |

So: **the user waits at most about three seconds**, and nothing is thrown away. That is a
number worth stating in the UI ("pausing…") and is strictly better than cancel-and-restart.

### 3.3 The scheduler

`server/pipeline/scheduler.js`:

```js
export const PRIORITY = { SCOPED: 1, BACKGROUND: 2 };   // lower runs first

scheduler.submit({
  priority,        // SCOPED for anything the user just asked for
  key,             // coalescing key, e.g. "backlog:embed+faces"
  job,             // the registry job (created BEFORE submit, per contract 2)
  body: async (ctx) => { … },
});
```

`body` receives `ctx.checkpoint()`, which is what `runSweep` awaits:

```js
// server/ml/sweep.js — the ONE line preemption costs
for (;;) {
  abortIfCanceled();
  await checkpoint();      // NEW: park here if higher-priority work is waiting
  await idle();            // unchanged: let the user's thumbnails go first
  const batch = nextBatch();
  …
}
```

Rules, and the requested behaviours that fall out of them rather than being special-cased:

- **Exactly one runnable pipeline at a time.** They contend for CPU, the ONNX worker, libvips
  and the same 16-slot libuv pool.
- `checkpoint()` resolves immediately unless a **strictly higher** priority run is queued or
  running. Otherwise it parks and resolves when nothing higher-priority remains.
- **Equal priority does not preempt — FIFO.** Therefore *"two scoped requests arriving in
  sequence"*: the first runs to completion, **including its grouping**, then the second runs;
  the background sweep stays parked through both, because at every checkpoint it still sees
  higher-priority work outstanding. Requested behaviour, zero special-casing.
- **`key` coalesces.** A second BACKGROUND submission with a key already queued is dropped and
  the response says so — it would recompute the identical worklist.
- **The parked run holds no resources.** The face engine and the configured ML worker are owned
  by the *scheduler* as a ref-counted holder, not by each run. A parked run drops its ref; the
  incoming run takes it and inherits the already-loaded ~200 MB session. Same model in the
  overwhelming majority of cases, so this is a strict win: **one session load, ever**. If the
  incoming run wants a different face pack, the holder rebuilds — that case must be tested.

### 3.4 Resume point, and the app quitting while paused

**There is no stored resume point, and this is the design's main claim.** A parked run is a
live JS closure holding counters and nothing else; on resume `nextBatch()` re-queries SQL. If
the app quits while paused, the registry `Map` dies with the process and the next scan or kick
re-derives the *identical* worklist from the database. The `faceGrouping.js` property — "there
is no checkpoint to corrupt, because the DATABASE is the checkpoint" — is preserved unchanged.

What is lost on quit: the run's *intent* (which stages were enabled for that scope) and its
counters. Both are cheap to reconstruct — stages come from settings, counters from coverage —
and neither is data.

### 3.5 Starvation, stated rather than hidden

A background run can be parked indefinitely if scoped requests keep arriving. That is *correct*
— the user is asking for those — but it must never be silent:

```
⏸  Scanning the library      12,410 / 125,431      Paused — waiting for "Scan Cards/Cam 1"
```

---

## 4. The JobsPanel contract

### 4.1 One job row per RUN

Not one per stage. The user asked for *one process*; five rows is five processes.
`registry.create("pipeline", {label, total})`.

### 4.2 `total` is milliseconds of estimated work, set at `registry.create`

The contract's hard rule is that `total` is known before the job row exists, and its own
worked example says **"Progress is measured in WORK, not in items"** (the `face-cluster` bar
reports pairs, not rows, for exactly this reason).

Photo-stages are not equal work: metadata is ~12 ms, embedding ~40 ms, faces ~300 ms per photo.
A bar in photo-stages would sprint through metadata and crawl through faces. So:

```
total = Σ_stage  pendingInScope[stage] × msPerPhoto[stage]
done  advances by msPerPhoto[stage] per photo classified
```

`pendingInScope[stage]` comes from `coverage.js`, computed **once, up front, before
`registry.create`** — the same discipline `faceSweepPending` already enforces (`api.js:1807`)
and the same failure it exists to prevent (#208: a total that arrives one batch late is an
indeterminate bar at exactly the moment the user is deciding whether it hung).

`msPerPhoto` comes from the constants that already exist: `approxMsPerPhoto` in
`ml/models.js` and `ml/faceModels.js`, plus two new measured constants for meta and hash.
**One place, already used for the scope control's estimate**, so the bar and the "about N
minutes" cannot disagree.

Honest trade-off, to be written in the code: the estimate is per-machine and the implied ETA
can be off by 2×. That is still far better than an item count off by 30×, and the *proportion*
— which is what a bar communicates — is right.

**Grouping is deliberately NOT in `total`.** Its work is (new faces × people so far), which is
unknowable up front and would force `total` to be revised mid-run — the exact #208 failure.
It appears in `phase` instead. Say this in a comment so nobody "fixes" it.

### 4.3 `phase` answers the user's third ask

```
phase: "Faces · 1,240 of 4,210 · 3,102 faces in 812 people"
phase: "Grouping 412 new faces"
phase: "Embedding · 8,900 of 12,000"
```

"how many faces have been found, in how many groups, and if progress is being made" — in the
place the user is already looking, updated per batch.

### 4.4 Paused rendering — four changes, all required together

1. **`registry`**: add `pause(id, reason)` / `resume(id)`. **`cancel(id)` currently refuses any
   job whose status is not `"running"` (`registry.js:101`) — it must accept `paused` too**, or
   a paused job is uncancellable, which fails contract 2 outright. `dismiss` must keep refusing
   it (it has not finished).
2. **`JobsPanel.svelte`**: `paused` currently falls into the final `{:else}` and renders a red
   `✗` with `job.error`. It needs its own branch — `⏸`, neutral colour, the reason, a working
   Cancel, and the progress bar **frozen at its last value, not made indeterminate**. The
   numbers are known; freezing them is the truth, and an indeterminate bar reads as a hang.
3. **The pill**: `paused` must not count as `broken` (`JobsPanel.svelte:48`). Priority becomes
   broken > running > paused > stopped > done.
4. **`ui/src/lib/jobs.js:117` `waitForJob`**: `if (job.status === "running" || job.status ===
   "paused") { onProgress?.(job); return; }`. Without this every waiter — including the
   progressive-render path CLAUDE.md describes (`crossedStep`) — resolves the moment a job
   parks and behaves as if the scan finished.

And, as a bonus, this replaces the two existing fake pauses (`api.js:314`, `api.js:448`) that
today render as red failures for an unmounted drive.

### 4.5 Cancel, per stage

Cancelling a pipeline run:

- stops after the current batch;
- **keeps everything committed.** Every per-photo stage commits per batch, and `groupRemaining`
  commits per batch. The only all-or-nothing pass in the codebase is
  `clusterFaces` + `saveClusters`, and it is **not** in the pipeline;
- runs no further stages;
- **skips the global consolidation**, reusing `kickEmbedSweep`'s existing rule that regrouping
  a half-embedded library "would look like a finished answer";
- reports `canceled`, not `failed`, and still says what was kept — because "it keeps what it
  finishes" is the property that makes stopping safe to do.

### 4.6 A stalled stage does not fail the run

When `runSweep` returns `{paused: true, pauseReason}` (host failure: missing weights, dead
worker, unmounted drive), the pipeline records **that stage** as stalled with its reason, skips
it for the rest of the run, and **continues with the remaining stages**. A missing face model
must not stop hashing. The summary then says so specifically. This is strictly better than
today, where each stage's failure is an unrelated red row.

### 4.7 `summarize()` branch

```js
if (job.type === "pipeline") {
  // Order: what the user asked about, then the new signals, then what went wrong.
  const parts = [`${n(r.photos)} photos`];
  if (r.faces)     parts.push(`${n(r.faces)} faces in ${n(r.people)} people`);
  if (r.embedded)  parts.push(`${n(r.embedded)} embedded`);
  if (r.hashed)    parts.push(`${n(r.hashed)} hashed`);
  if (r.failed)    parts.push(`${n(r.failed)} unreadable`);
  for (const s of r.stalled ?? []) parts.push(`${s.id} skipped: ${s.reason}`);
  return parts.join(" · ");
}
```

Disabled stages contribute nothing rather than reporting zero — "0 faces" for a user who never
turned faces on is a bug report waiting to be filed.

---

## 5. Migration

Five phases, each independently shippable, each a patch bump with a `CHANGELOG.md` line.
No big-bang rewrite, and nothing on the server is deleted.

### Phase 0 — one source of truth for "pending" *(no user-visible change)*

- New `server/pipeline/stages.js` with the `STAGES` descriptors and the four `PENDING_*`
  strings.
- Refactor `pendingEmbedRows`, `pendingFaceRows`, `pendingMetaPhotos`, `pendingHashRows` to
  build their `WHERE` from them.
- Fix the two data bugs in §2.4.
- Tests: each worklist returns identical rows before/after; `queryPlan.test.js` gains an
  assertion per predicate.
- **Verification note:** after moving functions between server modules, run
  `node -e "import('./server/pipeline/stages.js')"` — `AGENT-NOTES.md` documents that
  `npm test` can be green on code plain Node refuses to load.

### Phase 1 — coverage *(independently valuable; answers ask #3 on its own)*

- `server/pipeline/coverage.js` + `POST /api/pipeline/coverage`.
- `ScopeControl` gains the fourth "Keep only" option when a keep-scope is in force;
  `scopeControl.js`'s `buildScopes` grows one entry; `docs/UI-CONTRACTS.md` §1 gets its
  amendment in the same commit.
- `MlSettings.svelte` and `FaceSettings.svelte` read `allCount` from coverage instead of from
  two different endpoints.
- `GET /api/ml/faces` and `GET /api/ml/stats` keep working unchanged.

### Phase 2 — the scheduler, with today's jobs as its clients *(where preemption ships)*

- `server/pipeline/scheduler.js`; `runSweep` gains its one `await checkpoint()`.
- Convert `kickHashSweep`, `kickEmbedSweep`, `kickNearDupeSweep`, `POST /api/ml/faces` and
  `POST /api/ml/faces/cluster` to submit through it. The six `inFlight` latches become
  assertions or are deleted.
- `registry` gains `paused`; the four changes in §4.4 land together.
- The hand-written `409`s between stages become *queueing* instead of refusal — which is
  itself a user-visible improvement, and testable on its own.
- e2e: start a background sweep, fire a scoped request, assert the scoped job reaches `done`
  while the background job shows `paused`, then resumes. `trackPageErrors` throughout.

### Phase 3 — the runner and the one button

- `server/pipeline/run.js` + `POST /api/pipeline/run { scope, stages? }`.
- `POST /api/scan` chains a pipeline run over what it scanned (by `folderId`, per §1.4
  mitigation 1) instead of `kickHashSweep` + `kickEmbedSweep`.
- The Scan control becomes **"Scan my photos"** with a stage checklist derived from settings
  (`enabled`, weights present) — and it is a checklist, not a hidden policy, because
  downloading a 191 MB model still requires explicit consent (`FaceSettings.svelte`'s whole
  reason for existing).
- `summarize()` gains its `pipeline` branch.

### Phase 4 — demote, do not delete

- `POST /api/ml/embed`, `POST /api/ml/faces`, `POST /api/ml/faces/cluster` **all stay exactly
  as they are.** They are now "run just this stage, on this scope" — a legitimate advanced
  affordance, and the thing the settings panel already renders.
- What changes on the client: `FaceSettings`' "Group N faces" button loses its primacy (grouping
  is automatic now) and sits beside "Regroup everything…"; the `clusterJob` gating that
  currently disables the scan button disappears, because the scheduler orders them.
- **Nothing is removed from the server.** Removal, if ever, waits until John has run the
  pipeline for a while.

### Explicitly out of scope

Rewriting `runSweep`. It is the right abstraction; the pipeline is a *caller* of it.

---

## 6. Testing

Per `docs/TESTING.md`, pushed as far down the pyramid as each thing allows.

**vitest (tier 1)** — the bulk of it, and all of it DOM-free:

- `stages.test.js`: each pending predicate selects exactly the rows its old worklist did.
- `coverage.test.js`: library/filter/ids scopes; empty ids is refused, not widened; keep-scope
  coverage matches an equivalent explicit id list.
- `scheduler.test.js`: a BACKGROUND run parks when a SCOPED one is submitted; two sequential
  SCOPED runs are FIFO and the BACKGROUND one stays parked through both; the resource holder
  is not rebuilt when models match and *is* when they differ; `key` coalescing drops the
  duplicate.
- `run.test.js`: cohort ordering; a stalled stage does not fail the run; cancel keeps committed
  work and skips consolidation; `total` equals `Σ pending × msPerPhoto` at creation and is
  never rewritten.
- `registry.test.js`: `cancel` works on a `paused` job; `dismiss` refuses one.

**Playwright (tier 2)** — only where the bug lives between the parts:

- the paused row renders neutral with a working Cancel, and the pill does not say "failed";
- a scoped scan while a background sweep runs finishes first, and the background one resumes;
- `waitForJob` does not resolve early when a job parks (this is a *load-order* bug and no unit
  test can see it);
- `trackPageErrors(page)` in every spec.

**Do not add a new e2e fixture.** Extend the shared one: `seedFaces` already exists for #232,
and per `AGENT-NOTES.md` anything that seeds people must `clearFaces` in `afterAll` or it
widens the toolbar and folds unrelated groups into the overflow popover.

---

## 7. Open questions

1. **Cohort size.** 500 is a guess. It should be chosen so a cohort is ~1–2 minutes of work,
   which depends on which stages are on. Consider deriving it from `msPerPhoto` rather than
   fixing it.
2. **Does John want grouping to happen inside a *scoped* run, or only at the end?** Per-cohort
   grouping is correct and free (§1.3) but it means people appear and get named while a run is
   still going, and a later cohort can create a *second* person for someone the user just named.
   `assignNewFaces` running first mitigates it. Worth confirming with him.
3. **Should `near-dupes` run at the end of a *scoped* run at all?** It is whole-library and
   wholesale. Proposal: debounce it — schedule one global consolidation, coalesced by key, a
   minute after the last run finishes, so ten folder scans cost one regrouping.
4. **The fourth scope radio** (§2.1) requires amending `docs/UI-CONTRACTS.md` §1. Confirm before
   writing it.

---

## 8. What I could not verify

Stated plainly, because the codebase has caught wrong assumptions before.

- **No Bash tool in the session that produced this document.** No `npm test`, no
  `EXPLAIN QUERY PLAN`, no `gh issue list`. Every performance number is either quoted from a
  comment in the repo or explicitly marked as an estimate to be measured.
- **No duplicate-issue search was done.** (Done since — see the header: #258 and its
  sub-issues.)
- **The cohort OR-query cost is unmeasured** (§1.4) and is the single largest technical risk.
- **`META_BATCH`** — `BATCH` referenced at `api.js:1245`, definition not read.
- **`msPerPhoto` for meta and hash do not exist yet** and would have to be measured on John's
  library, not guessed.
- **`groupNearDupes`/`replaceNearDupeGroups`** — call sites and `kickNearDupeSweep` were read,
  `server/ml/nearDupeSweep.js` itself was not. The "not monotone, replaces wholesale" claim
  comes from the comments at `api.js:489-500` and `schema.js:380`; confirm against the source.
- **The `faceCounts` stale-row bug (§2.4)** was found by reading SQL, not by running it.
