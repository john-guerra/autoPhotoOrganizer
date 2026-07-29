# The Face Map — a projection view with lasso-merge (#232)

**Status:** design, approved in outline; the seam for #165 is designed but not built.
**Evidence:** every number here is measured. `docs/experiments/2026-07-28-face-projection/`
holds the scripts, the raw results and an architecture review of an earlier
draft of this document.

---

## The problem, in this library's actual numbers

|                                     |                                                                  |
| ----------------------------------- | ---------------------------------------------------------------- |
| Faces detected (`buffalo_s`, 512-d) | 118,371                                                          |
| Faces assigned to a person          | 48,585 (41%)                                                     |
| **Faces in no group at all**        | **69,786 (59%)**                                                 |
| Persons                             | 25,758 — of which **6 are named**                                |
| Group sizes                         | 20,259 singletons · 4,777 with 2–5 · 722 with >5 · biggest 3,512 |

Grouping splits one human across many person-groups. The People view (#223)
made that **visible**; merging them one dropdown at a time does not scale to
25,758 rows. This makes it **fixable in bulk**: see the people laid out by
facial similarity, lasso the ones that are obviously the same person, merge
and name them in one action.

Two numbers shape every decision below:

- **20,259 of 25,758 persons are singletons.** A person seen once cannot be
  "one human split across many groups"; they are a stranger in the background.
  The real working set is the **5,499 persons with ≥2 faces**.
- **Only 6 people are named.** The job here is not only _merge_ — it is
  _name_, and merging is how you assemble a blob worth naming. Naming is
  therefore part of the merge action, not a separate errand.

---

## What it is

A registry view (`docs/UI-CONTRACTS.md` §3) in the main area. Each dot is one
**person**, positioned by a 2-D projection of that person's face-embedding
centroid, sized by face count, coloured by named/unnamed, and drawn as their
cover crop when zoomed in far enough to see it.

Drag a lasso → the caught people land in a **review tray** as crops with face
counts → drop any that don't belong → merge them into one person and name
them, in one action, undoably.

---

## Architecture

### 1. The projection runs in a `worker_threads` worker

Measured, at 25,758 person centroids: umap-js's `initializeFit` is **14.1 s
inside a single call with no callback**, peaking at **1,825 MB**.

That rules out the main process on two independent grounds. There is no yield
point to budget, so #231's fix does not apply — and #231 was exactly a
10.3 s event-loop block that disconnected the client. And 1.8 GB of transient
heap does not belong in the process serving thumbnails.

It also rules out the existing ONNX child process (`OnnxMLService`): that is an
inference queue, and a 20 s projection would head-of-line block an embed in a
process already holding ONNX sessions.

A worker thread gets three properties **by construction** rather than by
discipline:

|                                                       |                                                     |
| ----------------------------------------------------- | --------------------------------------------------- |
| Separate heap                                         | the peak lives and dies in the worker               |
| Cancel that works during the unyieldable phase        | `worker.terminate()` uses V8's `TerminateExecution` |
| An OOM that is a _catchable job failure_, not a crash | `resourceLimits.maxOldGenerationSizeMb`             |

That last one matters most and was not in the original rationale. A projection
that OOMs on the main thread is an app crash with nothing reported anywhere. In
a worker with an explicit limit it is an `ERR_WORKER_OUT_OF_MEMORY` event the
supervisor turns into a specific, actionable message — _"This library is too
large to map on this machine. Raise the minimum-faces filter and try again."_
That is `CLAUDE.md`-compliant failure; a segfault is not.

**Invariant that keeps the worker simple: it never touches SQLite and imports
nothing native.** The parent reads centroids, transfers a `Float32Array`, the
worker returns coordinates, the parent writes. So `better-sqlite3`'s ABI trap
stays entirely outside it, and its whole dependency surface is `umap-js`.

**Protocol.** `workerData` carries the transferred buffer and params. Messages
back are a `switch` on `msg.type`, never an `if` — that is the seam that lets a
streaming variant be added later without reshaping the handler:

| frame                            | when                                        |
| -------------------------------- | ------------------------------------------- |
| `{type:"phase", phase, note}`    | entering kNN / entering epochs              |
| `{type:"progress", done, total}` | every ~8 epochs                             |
| `{type:"done", xy}`              | end, transferred back                       |
| `{type:"embedding", epoch, xy}`  | **reserved, not built** — see "Cut from v1" |

`error` and `exit` race to settle one promise and must settle it **idempotently,
keyed on worker identity** — verbatim the `#killChild` pattern in
`OnnxMLService.js`, which exists because a double-settle there took the server
down. Always `terminate()` in a `finally`; never `unref()` (an unref'd worker
still allocates, it just stops holding the process open).

### 2. `minFaces` is a **run parameter**, defaulting to 2

This is the single highest-leverage decision in the design, and an earlier
draft had it wrong as a client-side filter. It cannot be client-side: hiding
dots after the fact does not re-lay-out, so the surviving positions would still
encode 20,259 singletons pulling on the graph — precisely the artifact that
justifies not offering a subset scope in the first place.

Measured, and the reason it is the default:

|                                         | 25,758 persons (`minFaces: 1`) | **5,499 persons (`minFaces: 2`)** |
| --------------------------------------- | ------------------------------ | --------------------------------- |
| `initializeFit` — the unyieldable block | 14.1 s                         | **2.1 s**                         |
| total                                   | 20.5 s                         | **4.0 s**                         |
| peak RSS                                | 1,825 MB                       | **824 MB**                        |
| t-SNE                                   | ~47 min (infeasible)           | ~2 min (affordable)               |

The dots this removes are exactly the dots that are noise for this task. And
`minFaces: 1` stays available, offered with its cost quoted.

### 3. The cache: a snapshot, joined against live data

```sql
CREATE TABLE projection_runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,          -- 'person' now, 'photo' for #165
  model TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  params_key TEXT NOT NULL,    -- canonicalised, sorted-key digest: the cache key
  params TEXT NOT NULL,        -- the readable JSON
  members INTEGER NOT NULL,
  created_at INTEGER NOT NULL);

CREATE TABLE projection_point (
  run_id INTEGER NOT NULL,
  ref_id INTEGER NOT NULL,     -- deliberately NOT a cascading FK, see below
  x REAL NOT NULL, y REAL NOT NULL,
  PRIMARY KEY (run_id, ref_id)) WITHOUT ROWID;
```

`kind` is what makes #165 a second row rather than a second schema.

**Points are served via `INNER JOIN persons`.** The consequence is the neatest
property in the design: the moment you merge eight people away, their dots
vanish and the target keeps its position — **the map stays truthful about who
exists with no re-projection.** Only _where they'd sit_ goes stale, and the
header says how stale.

Two things that look like omissions and are not, both of which need the
reasoning written into the schema comment or the next reader will "fix" them:

- **No `ON DELETE CASCADE` on `ref_id`.** The point rows must survive a merge
  so that an **undo brings the dot back**. The INNER JOIN already hides them.
  Genuinely orphaned points are swept at run-creation time by `pruneRuns`.
- **`params_key` is a canonicalised digest, not the raw JSON.** `{"a":1,"b":2}`
  and `{"b":2,"a":1}` are the same run; keying on raw JSON would compute it
  twice.

Determinism is what makes the cache correct: umap-js's `random` option takes a
function, so the worker supplies a seeded PRNG (a 4-line mulberry32 — no new
dependency) and `seed` is part of the key. Member order is also part of
correctness: `personCentroids` orders by `persons.id`, because UMAP is
order-sensitive and two "identical" runs with different row order produce
different maps.

### 4. The job

`POST /api/projections` → `{jobId}`, or `{reused: runId}` with **no job at
all** when that exact run is already cached. Contract 2 in full:

- **`total` is set at `registry.create`**, which requires passing `nEpochs`
  explicitly rather than letting umap-js derive it from its own size heuristic.
  A total that arrives one tick late is #208.
- **Two-phase progress, and this is legitimate.** §2 forbids an indeterminate
  bar against a _knowable_ total. During `initializeFit` the total genuinely is
  not knowable — one opaque call, no callback. So phase 1 is indeterminate with
  a **moving** phase string (elapsed seconds, updated from the parent, since the
  worker is blocked and cannot post), and phase 2 is proportional over epochs.
  At the default `minFaces: 2`, phase 1 is 2.1 s and the question is nearly
  moot.
  Note epochs are _uniform_ work, unlike `clusterFaces`' upper triangle, so an
  epoch-index bar is honest here — the "work, not items" rule does not bite.
- **Every refusal is synchronous and precedes `registry.create`** — model
  missing, `isClusterInFlight()`, `isProjectionInFlight()`, cache hit.
- **A single-flight latch**, copying `withClusterLatch` including its `finally`.
- **A `summarize()` branch** in `JobsPanel.svelte`: _"5,499 people · UMAP · 4.2 s"_.
  Without it a finished run is a bare ✓.

**`setPrecomputedKNN` evaluated and rejected** — recorded so it is not
re-proposed. It would buy proportional progress during phase 1, but exact kNN
in 512-d is a linear scan: at this repo's own measured 2.7 M int8 pairs/sec,
the 25,758-point upper triangle is ~123 s against umap-js's approximate 14.1 s.
Honest progress at 9× the wall clock is a bad trade.

### 5. The algorithm menu — kept, but gated and annotated

The architecture review argued for cutting this to UMAP-only, on the grounds
that a dropdown containing three known-bad options is a footgun. The objection
to the objection: this app's user asked for algorithm choice specifically and
knows what these algorithms are. The genuine risk is not confusion, it is
**offering something that will wedge for 47 minutes**.

So the menu ships, with two guardrails that come straight from the
measurements:

- **Feasibility-gated by member count.** t-SNE is offered only when the member
  count is under ~6,000 (where it costs ~2 min); above that it is visible,
  disabled, and says why.
- **Annotated with its measured score.** Each option carries the twin-rank
  number from the experiment — _"t-SNE — slower, best separation (93% top-5)"_,
  _"PCA — instant, poor separation (7% top-5), for sanity checks"_. That turns
  a footgun into information, which is the whole point of exposing the choice.

v1 ships **UMAP** (default), **t-SNE** (gated), **PCA** (baseline). All
permissive. `MDS`/`SQDMDS` are **not** offered: SQDMDS scored 0.0% on the real
test with a median rank of 1,822, and is documented in the experiment folder as
_the trap_ — perfect on a naive benchmark, worst in practice.

The **parameters** gear is the other half of the request and is cheap:
`minFaces`, `nNeighbors`, `minDist`, `nEpochs`, `seed`. These change the map
more than the algorithm does.

### 6. Licensing

`umap-js` is **Apache-2.0**, not MIT — its `package.json` says MIT but the
shipped `LICENSE` and every source header are Apache-2.0 (`Copyright 2019
Google LLC`). Permissive and fine inside an MIT app, but §4 requires retaining
the notice and licence text in redistributions, and this app ships a packaged
binary. `@keckelt/tsne` is MIT (verified); `ml-pca` is MIT.

**Deliverable:** a `THIRD-PARTY-NOTICES.md` packed via `build.files`. This
feature adds the repo's first Apache-2.0 dependency, so it owns creating that
surface.

DruidJS was evaluated and rejected on two grounds: LGPL-3.0-or-later against
this repo's MIT, and its UMAP is ~20× slower (exact `BallTree` kNN in 512-d
degenerates to linear scan — 125.7 s and 5.1 GB at 8,000 points, no result at
25,758 after 25 minutes).

---

## The scatter component, and the seam for #165

### Pure modules — `ui/src/lib/scatter/`

The `albumTimeline.js` discipline exactly: the component draws, these answer
questions, so hover and click cannot disagree.

| module         | exports                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| `transform.js` | `toScreen`, `toData`, `fitExtent`, `clampZoom` — the ONE definition of screen↔data |
| `hit.js`       | `buildIndex` (d3-quadtree), `nearest(index, x, y, r)`                              |
| `lasso.js`     | `pointInPolygon`, `polygonBBox`, `simplify`, `caught(index, poly)`                 |
| `lod.js`       | `imageSide(k)`, `shouldDrawImages(k)`, `imageBudget(n)`                            |

### `ScatterCanvas.svelte` — the dumb renderer

```js
<ScatterCanvas
  points={{ x: Float32Array, y: Float32Array, ids: Int32Array,
            size: Float32Array|null, group: Uint8Array|null }}
  {width} {height}
  imageFor={(i) => string|null}    // url for point i; null = draw a dot
  labelFor={(i) => string}
  highlighted={Set<number>}        // INDICES
  onlasso={(indices, mods) => {}}
  onhover={(index) => {}}          // -1 for nothing, hitAt's convention
  onpick={(index, event) => {}}
  bind:transform                   // {k, tx, ty}
/>
```

Two rules make this a real seam rather than a hopeful one, and **a structural
test enforces both**: the module must not import `api.js` and must not contain
the strings "person" or "face".

- **Every callback speaks INDICES, never ids.** The component never learns what
  a point means.
- **Parallel typed arrays, never an array of objects.** #165's 64,026 photo
  points would otherwise be 64,026 JS objects.

#165 then supplies `imageFor = (i) => thumbUrl(ids[i])` and a view descriptor.
That is the whole diff.

### 25,758 crops without 25,758 `<img>` elements

1. **LOD by construction.** Crops draw only when a point occupies ≥ ~24 CSS px,
   which means ~100–400 points are ever on screen at once. `shouldDrawImages(k)`
   is the single predicate.
2. **An LRU cache of `HTMLImageElement`, ~600 entries**, plus an in-flight Set.
   Request viewport points only, nearest-to-centre first.
3. **A coloured dot always draws underneath.** An unloaded crop is a dot, never
   a hole.
4. **Request `size=160`, the same size `PeopleView` uses** — the crop cache is
   keyed `(photo, faceId, px)`, so a different size would generate a second full
   generation of cached JPEGs. Reusing People's warm cache is free, and matters
   because a miss costs a full `sharp` decode of the original.

Two layered canvases: a points layer redrawn on transform/data change, an
overlay redrawn per pointer frame for the lasso path and hover ring. Sub-3px
dots use `fillRect`, not `arc`.

---

## The interaction

### Lasso → tray → merge

Shift-lasso adds, alt-lasso subtracts (the d3 idiom). The tray shows every
caught person as a crop with its face count; clicking one drops it. Then one
bar: **"Merge 8 people · 412 faces into [name…]"**, autocompleting existing
names.

**Two differently-named people in the lasso must not resolve silently.**
`mergePersons`' existing `into.name || from.name` rule is right for a two-person
merge where the user pointed at a row; in a lasso there is no row they pointed
at, and losing a name is invisible data loss found weeks later. If the caught
set holds ≥2 distinct non-empty names, the tray **refuses to merge until the
user picks**, showing the candidates as options plus "type a new one". With
exactly one name, pre-select it. With none, the field is the naming input the
workflow wants anyway.

### `mergePersonsBulk`, not a loop over `mergePersons`

Looping breaks four ways, and the first is quadratic: `UPDATE photo_faces SET
person_source='manual' WHERE person_id = into` re-runs per source over the
target's _growing_ face set — a 500-person lasso onto the 3,512-face target is
on the order of a million redundant updates. Also the surviving name would
depend on loop order, `cover_face_id` is never revisited, and one missing row
rolls back 499 good merges.

`mergePersonsBulk(db, intoId, fromIds, { name })`: one `UPDATE … WHERE
person_id IN (…)`, one mark on the target, one `DELETE … IN (…)`, one cover
recompute (highest `det_score` across the merged set, reusing `saveClusters`'
`bestOf` rule) — in one transaction. Returns `{id, moved, name, mergedCount,
missing}` so the UI can say _"merged 497; 3 were already gone"_.

It refuses with a 409 while a regroup is in flight, mirroring the cluster
route.

### Undo — server-side, and the field everyone forgets

Stored server-side rather than as a client-held manifest, for two reasons: the
existing `undo-move` pattern's known failure is quoted in `CLAUDE.md` (_"the
move record was too large to send"_), and a server-held record **survives a
page reload**.

```sql
CREATE TABLE person_merge_undo (
  token TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
  into_id INTEGER NOT NULL,
  into_name_before TEXT,     -- an inherited name must be reversible
  payload BLOB NOT NULL);
```

**The forgotten field is per-face `person_source`.** The merge sets every moved
face _and every one of the target's own faces_ to `'manual'`. An undo that
restores `person_id` alone silently freezes those faces as human decisions,
which no future grouping pass can ever revise. The record stores the prior
value per face, for both sides, and restores it.

Capped in two places because they fail differently: **10 merges** by row count
(same reasoning as `RECENT_MAX`), and a refusal with a specific message above a
stated face-count cap rather than writing an undo record that cannot be
honoured.

Not a job — ~100k row updates in one SQLite transaction is well under a second.
`undo-move` is a job only because it does filesystem work.

---

## Contract conformance

### Contract 1 — scope

This operation has exactly one scope dimension, **`minFaces`, and it is a run
parameter**. The contract does not mandate three radio buttons; it mandates
that the user is never offered a single button meaning "spend twenty minutes on
everything". Satisfied by: a **live count** next to the choice (_"≥2 faces ·
5,499 people"_ / _"everyone · 25,758 people"_), an **estimate that tracks it**
via the existing `formatEstimate` rather than a second copy of the arithmetic,
and a **specific refusal** when the filter leaves too few people to be a map.

`ScopeControl.svelte` is deliberately **not** wired: its `name`-uniqueness and
`scopeIdsFor(null vs [])` machinery is about photo-id lists, and this is not
one. Forcing it in would be the worse violation.

A second instance, easily missed: **the merge is itself an operation over
photos** (it rewrites `photo_faces`). Its scope is the review tray — a
live-counted, user-editable set with drop. That _is_ contract 1 in a different
shape, and the view's doc comment says so, so its absence is not read as an
omission.

### Contract 2 — locus of control

Covered in "The job" above. The one requirement worth restating: **a cache hit
starts no job at all**, which is the "if the pending count is zero, say so and
start no job" rule applied to a different quantity.

### Contract 3 — placement, capabilities, and a registry gap

Placement is straightforward: a map of your people is a view, not a panel. The
per-view configuration gear is the view's own controls, the shape `AlbumsView`
already has.

**Capabilities: `open: true`, `select: false`, `rate: false`.** `open` is true
and this is a change from the first draft — you cannot judge a merge from a
160 px crop, so clicking a crop in the tray opens that face's photo in the
loupe, exactly as `ALBUMS` does. Declaring `false` while wiring photo-opening
would be a lie that nothing currently catches, because `capabilities.open` is
read by nothing yet; the moment something reads it, the feature breaks.
`select` and `rate` are false for `PeopleView`'s exact reason: `selected`
indexes a feed window this view does not render.

**The registry has no field for view-local keys, and this view is the first to
need one.** §3's own table says "view-specific keys, declared" belongs to the
view, but `App.svelte`'s `onKeydown` owns the window. Concretely, `X` here
would hit `refuseUnsupported("select", "Selecting photos")` and tell the user
_"Selecting photos isn't available in Face Map"_ — while the view has a
perfectly good selection of people. That message is actively wrong.

**Deliverable, first and alone, as its own commit** (per §3's "do the registry
first" rule): one declarative field —

```js
keys: [{ keys: ["Esc"], label: "Clear the lasso" }, …]
```

— consumed by `ShortcutsOverlay.svelte` so the "a shortcut nobody can find does
not exist" rule holds automatically, and consulted by `refuseUnsupported`
before it refuses. ~20 lines, and it is the fourth view paying #155's dividend
rather than re-deriving the boundary.

---

## Never fail silently

Three states the view must name, because all three are currently surprising:

1. **No projection yet.** Say so and offer to build one, with the count and the
   estimate. Never an empty canvas.
2. **The 59% that cannot be shown.** _"48,585 of 118,371 faces are grouped —
   the rest have never been through a grouping pass. [Group faces]"_ Without
   this line, a user who lassos the whole map and merges reasonably concludes
   they are done.
3. **Staleness.** _"Map built 2 minutes ago from 5,499 people. 12 people added
   since."_ The INNER JOIN keeps _who exists_ truthful; only positions age.

Plus: which **model** the map is of (`buffalo_s` vs `buffalo_l`), or a pack
switch shows a stale map with nothing explaining it.

---

## Traps this inherits

|                                         |                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Toolbar folds by width**              | This is the 4th view. `PersonFilter` learned it once, #223 again at 1280px — **CI-only, 151/151 green locally**. Use `offerable`, gated on a projection run existing rather than `peopleCount > 0`. A green local e2e does not clear this.                                                                |
| **`navigation: "zoom"` is unexercised** | First view to use it. `.main-column` is `overflow-y: auto` with `onwheel={releaseJumpPins}`. The view must fill the column, set `overflow: hidden`, and `preventDefault()` on wheel. A real task, not a CSS afterthought.                                                                                 |
| **`ResizeObserver`**                    | Never re-lay-out inside the callback; defer a frame as `ToolbarRow` does, or `trackPageErrors` fails.                                                                                                                                                                                                     |
| **`$effect` self-write loop**           | `transform` (`{k, tx, ty}`) is exactly `AlbumTimeline`'s documented shape: an effect that reads and writes the same `$state` re-fires forever. Drive redraw imperatively. All-runes, never half.                                                                                                          |
| **The `items` boundary**                | The view emits `onrun(params)`; **App** starts the job, awaits it, fetches points, passes them down. The view never fetches its own points — that is how the boundary rots.                                                                                                                               |
| **Packaging**                           | The #203 verification **does not transfer**: that was a spawned `ELECTRON_RUN_AS_NODE` child; this is a worker thread inside Electron's main process, a different asar path. Verify, then `asarUnpack` only if needed — #203's own conclusion was that its pre-emptive entry would have been dead weight. |
| **`queryPlan.test.js`**                 | New table, new access path; index-dependent plans rot silently.                                                                                                                                                                                                                                           |
| **`node -e "import(…)"`**               | After moving anything between server modules — vitest's SSR transform hides duplicate declarations that are a hard SyntaxError under real node (#221).                                                                                                                                                    |
| **Destructive-test isolation**          | The merge deletes `persons` rows: temp DBs in vitest, a `resetPeople` helper in `e2e/helpers.js`.                                                                                                                                                                                                         |
| **`ShortcutsOverlay` `V` label**        | Enumerates the views; a fourth means editing that string in the same commit.                                                                                                                                                                                                                              |

---

## Cut from v1

| cut                                   | why                                                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Streaming/progressive layout**      | Delightful, and a whole second data channel outside the job registry. `{type:"embedding"}` is reserved in the protocol; nothing is built. At 4.0 s there is nothing to stream.                                        |
| **JL 512→64 pre-reduction**           | Measured: 20.5 s → 13.2 s. Not worth the code or the unvalidated fidelity question — and `minFaces: 2` makes it moot.                                                                                                 |
| **A run browser / named runs**        | Keep the last 3 per `(kind, model)` and prune. Params in, map out; the cache is not a UI.                                                                                                                             |
| **An atomic merge-and-name endpoint** | `mergePersonsBulk` then `renamePerson`, both existing and tested. A third endpoint adds a partial-failure state for no gain. (The name **conflict resolution** stays — it is a precondition, not a second operation.) |
| **Per-item undo in the tray**         | Drop-any is enough; re-lasso is the undo. One undo, at the merge.                                                                                                                                                     |
| **Generalising `navigation: "zoom"`** | Implement this view's zoom concretely; do not generalise viewport ownership until a second zoom view exists.                                                                                                          |
| **#165's photo scatter**              | Its own spec. The seam costs nearly nothing _if and only if_ `ScatterCanvas` never learns what a point means — enforced by a test, not by intent.                                                                     |

**Kept because they are nearly free and carry real information:** dots sized by
face count (one `Float32Array`) and coloured by named/unnamed (one
`Uint8Array`). With 6 named of 25,758, "which have I already done" matters.

---

## Testing

Per `docs/TESTING.md`, pushed down wherever possible.

**Tier 1 (vitest)** carries the weight:

- `personCentroids` — unit-norm output, `minFaces` boundaries, a person with
  zero faces excluded rather than returned as NaN, mixed `dim` throws, **stable
  id order across two calls**.
- `runProjection` — 3 synthetic clusters separate; **determinism** (same seed →
  byte-identical output, which is what makes the cache correct); cancellation
  writes nothing; a throwing worker surfaces a real Error; `error`+`exit`
  settles once. This tier spawns the worker under **real Node**, so it also
  catches the vitest-vs-node trap for free.
- `projections` (cache) — round-trip, `findRun` misses on any one key field,
  `pointsForRun` INNER JOINs so a deleted person's point vanishes, `pruneRuns`.
- `scatter/*` — the lasso is where correctness lives: self-intersecting
  polygon, a point exactly on an edge, a polygon with <3 points, and a
  25,000-point benchmark proving the lasso is sub-frame. Plus the structural
  test that keeps the #165 seam honest.
- `mergePersonsBulk` — **the destructive one, tested heaviest**: 500 sources in
  one transaction; undo restores `person_source` **per face to its prior
  value**, not blanket-set; a name conflict is refused, not resolved; a person
  deleted mid-flight is skipped and reported; the undo log caps; `intoId ∈
fromIds` is filtered, not thrown on.
- Routes — every refusal is a synchronous 4xx **before** `registry.create`; a
  cache hit returns `{reused}` with no job; cancel lands as `canceled`.
- **The algorithm gate is a pure function and is tested as one.**
  `offerableAlgorithms(memberCount)` returns each algorithm with an
  `enabled` flag and a reason string, so "is t-SNE offered at 25,758 people?"
  is a unit test rather than a thing to eyeball in a dropdown. Assert: t-SNE
  enabled at 5,499 and disabled with a reason at 25,758; UMAP always enabled;
  SQDMDS/MDS never present at all. The `~6,000` threshold is an extrapolation
  from a 4,072-point measurement, so it lives in one named constant with the
  measurement cited beside it — not sprinkled through the component.

**Tier 2 (Playwright)** for what only a browser can see: `e2e/face-map.spec.js`
— lasso, drop one, merge, assert the person count fell by the right number,
undo, assert it came back. Per `docs/TESTING.md`, click the button; do not
merely assert it renders. `trackPageErrors` in every spec.

**The quality gate.** `twin-rank-hard.mjs` becomes a doubly-gated vitest
(`ML_INTEGRATION=1` + a fixtures path), skipping **loudly** exactly as
`embeddingSimilarity.test.js` does — a silent skip on the only check that the
coordinates _mean_ anything is indistinguishable from a pass. Current
measured baseline to regress against: UMAP 27.8% twin-is-nearest, 58.3% top-5
on a 36-pair hard split.

---

## Known weaknesses of this design

Stated rather than buried:

- **36 pairs is a small quality sample.** The ranking is unambiguous (0.0% vs
  93.1%) but these are not numbers to tune parameters against. The gate above
  is how that improves.
- **No method is a magic co-locator.** UMAP's p90 twin rank is 52. That is the
  honest argument _for_ a lasso rather than an automatic threshold — but it
  also means the map will not group everyone perfectly, and the view should not
  imply otherwise.
- **A centroid means less for the giant groups.** The 3,512-face person's
  centroid is an average over what is probably a garbage bin. Those are not
  merge candidates either, so it does not block v1 — but splitting a bad group
  is a real need this view cannot serve, and belongs in its own issue.
- **The packaging risk is open** until verified against a real
  `electron:build:mac` artifact.
