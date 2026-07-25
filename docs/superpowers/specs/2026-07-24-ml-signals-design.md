# Local ML signals and pluggable views — program design

**Status:** approved — decomposed into issues, none implemented
**Scope:** two tracks and the architecture they share — **ML signals** (places,
embeddings, similarity, semantic tags, faces) and **pluggable views** (the
contract, plus treemap, time, and embedding-scatter implementations). Each
shippable slice gets its own issue and, where it needs one, its own spec.

## Problem

The app can navigate photos by every dimension it can read off the file:
folder, date, camera, kind, rating, size, name. It cannot navigate by anything
_in_ the photo — who is in it, what it is of, where it was taken, or which other
photos look like it. On a 114,125-photo library that is the difference between
"find the folder I think it was in" and "find the photo".

Phase 2 of the founding design already committed to the answer — "face
detection/clustering + CLIP embeddings via transformers.js / ONNX Runtime in
Node. All local, all JS, computed lazily in the background, stored in the SQLite
index" (`2026-07-06-photo-triage-design.md:104-110`) — and `ROADMAP.md:140`
records it as a decision not to relitigate. `ProcessingService.js:11` already
names the swap seam. None of it was built.

Four open issues are waiting on this pipeline and cannot be answered without it:
**#14** (semantic/perceptual duplicate detection), **#17** (cluster a trip into
thematic sub-galleries), **#79** (AI-generated album names), **#10** (GPU archive
overview). They are not four separate problems. They are four consumers of one
embedding.

There is a second, independent problem this design also has to solve. Once
photos carry similarity, place, and people, **the justified grid stops being the
only sensible way to look at them** — a similarity scatter, a treemap by
folder size, and a time-shaped view each answer questions the grid cannot. But
the grid is not a component today; it is the implicit default woven through a
6,456-line `App.svelte`, which is why **#124** ("refactor App.svelte") has stayed
open with no obvious first move. Adding three more views as branches inside that
file would take it past 8,000 lines and close the door for good. So the views
need a contract before they need models — see §7.

## What makes this hard here (and it isn't the models)

The models are a solved commodity. The two real constraints are:

**1. The library is 114k photos and the app is single-process.** There is no
worker pool, no queue, no concurrency cap anywhere in `server/`. Every job is a
bare fire-and-forget async IIFE. Inference on the main event loop would starve
the thumbnails the user is scrolling through — the exact failure already measured
and documented in `server/lib/interactive.js:1-17` (thumbnails 15ms → 90ms under
a sweep, tiles abandoned mid-scroll, "N thumbnails failed to load").

**2. A sweep that does not drain is worse than no sweep** — and the codebase has
now made this mistake, fixed it, and in fixing it demonstrated the second
mistake.

Until 2.17.14, `hashPendingPhotos` ran once per scan with `limit: 50` while both
callers dropped its `remaining` flag, so **100 of 114,125 rows were ever hashed**
and `backupCoverage` was silently inert — a feature that appeared to exist,
reported plausible numbers, and was wrong. That is fixed: `hashAllPending`
(`server/db/hashing.js`) now loops to completion behind `whenIdle()`, is
single-flight, keeps its state in the DB so it resumes across restarts, and
marks unreadable files `hash_attempted` so it terminates.

**The fix is the point.** It is a good implementation, and it re-derived — by
hand, in a second file — the same four properties `/api/enrich` already had:
drain-until-empty, idle gating, a failure sentinel, single-flight. The two
implementations are now subtly different: enrich has a `registry` job, progress
reporting, cancellation via `job.controller.signal`, and per-file isolation on a
batch failure; `hashAllPending` has none of those. Same pattern, two authors, two
feature sets, no shared code.

And the hand-rolled version shipped a termination bug that the shared one would
not have: an unmount mid-sweep marks every unreachable file `hash_attempted`, and
because `upsertScan` only clears that flag when size/mtime _change_, an unchanged
file that returns with the drive is **excluded from hashing forever** (#169,
reproduced).

So the conclusion is not "avoid the bad pattern" — it is **stop writing the
pattern by hand**. `/api/enrich` (`server/api.js:742-801`) is the most complete
version: it drains (`for(;;)` re-querying `nextBatch()` until empty), stands
aside for the user (`await whenIdle()` between batches), isolates poison files
(batch failure → retry one at a time), writes a sentinel so a permanently
unreadable file leaves the pending set, and honours `job.controller.signal`.
Extracting it — and migrating **both** existing callers onto it — is the
foundation of this program. The ML sweeps would otherwise be the third and fourth
hand-copies, and the feed-window guard (six copies, two shipped bugs) is the
standing evidence for where that ends.

## Goal

| Capability       | User can                                                          | Surfaces as                     |
| ---------------- | ----------------------------------------------------------------- | ------------------------------- |
| Places           | Browse and filter by country → region → city                      | Group dimension + filter facet  |
| Image embeddings | (nothing directly — the substrate)                                | —                               |
| Similarity       | "More like this" from the loupe; browse by semantic cluster       | Anchored mode + group dimension |
| Near-duplicates  | Review suggested stacks of near-identical frames                  | Suggested burst stacks          |
| Semantic tags    | Filter by open-vocabulary content ("sunset", "dog", "whiteboard") | Filter facet                    |
| People           | Find every photo of a person; filter by them                      | Filter facet                    |
| Views            | Swap the grid for a treemap, a time view, or a similarity scatter | View registry (new)             |
| Group bands      | Draw a group as something other than a snapshot strip             | `groupRenderers.js` (exists)    |
| Tiles            | Draw a photo as something other than the one hardcoded thumbnail  | Tile registry (new)             |

## Architecture

### 1. `server/ml/` — the sidecar

Mirrors `server/processing/` deliberately, because it is the same shape of
problem and the codebase already knows how to read that shape.

- **`MLService.js`** — abstract base, all methods throw, JSDoc typedefs carry the
  contract. `embedImages(paths) → Float32Array[]`, `embedTexts(strings) →
Float32Array[]`, `detectFaces(path) → Array<{box, score, vec}>`.
- **`OnnxMLService.js`** — spawns and supervises a child process; does no
  inference itself.
- **`worker/index.js`** — the child. Loads transformers.js + `onnxruntime-node`,
  serves one request at a time over JSON-lines on stdio, unloads a model after an
  idle period to give the RAM back.

**Out of process is not optional.** In-process buys simplicity and costs the two
things that matter: inference would contend for the same 16-slot libuv threadpool
`server/index.js:19` already reserves for libvips, and a native-addon segfault
would take the whole app down. The child process gives a hard resource boundary,
a kill switch, and crash isolation — respawn with backoff, fail the in-flight
batch, mark those photos attempted, carry on. That _is_ the resilience
requirement; it is not a layer on top of it.

In a packaged build the child is spawned via `ELECTRON_RUN_AS_NODE=1` on the
Electron binary, so it runs on Electron's ABI. `onnxruntime-node` is a native
addon and therefore needs the **same treatment `better-sqlite3` already gets** —
`asarUnpack` (`package.json:96-102`) plus the `electron-rebuild` list
(`package.json:22`). Issue #67 is the cautionary tale: electron-builder's
built-in rebuild was a no-op that shipped a Node-ABI binary and crashed the app
on launch, which is why `npmRebuild: false` and CI rebuilds explicitly.

**Models are downloaded, never bundled.** First use shows what is about to be
fetched, how big it is, and its licence, then caches it under
`~/.autogallery/models/`. This keeps the shipped artifact small (relevant while
#136 leaves the mac arch matrix unresolved and #94 leaves us unsigned) and is the
mechanism that makes a non-commercial-licensed face model acceptable: the user
opts in, the binary stays clean.

### 2. `server/ml/sweep.js` — one drain, reused by every pass

Extract the loop from `/api/enrich` into a reusable function and migrate **both**
existing sweeps onto it — enrich and `hashAllPending` (`server/db/hashing.js`) —
so there is one implementation and it cannot drift. It already has: the two
differ today in cancellation, progress reporting, and job-registry visibility,
and the hand-rolled one shipped #169.

```js
runSweep(job, {
  nextBatch, // () => rows still owed work (a SQL partial index, re-queried)
  process, // (batch) => Promise<written>
  markFailed, // (row) => void — the sentinel write
  onProgress,
});
```

Three properties are load-bearing:

- **The worklist is a SQL partial index, not in-memory state.** `WHERE vec IS
NULL AND stale = 0`, following `idx_photos_pending_meta`
  (`server/db/schema.js:137-140`) — which exists because the sweep re-queries on
  every batch and would otherwise re-scan 100k rows ~2,000 times. A crash mid-sweep
  costs one batch, not the backlog, and the job resumes on restart with no
  bookkeeping.
- **Every stage needs a failure sentinel.** Without one, a poison photo keeps
  matching the worklist and the sweep spins on it forever. `photos.width = 0` and
  `lens = ""` already encode "attempted, nothing there"
  (`server/db/enrich.js:13-22`); ML stages get an explicit
  `ml_status(photo_id, stage, state, attempts, error)` row instead of overloading a
  data column, because a failed embedding has no natural zero value.
- **Single-flight per stage.** Two scans finishing near each other must not start
  two sweeps over the same worklist.

Scheduling stays exactly as it is today: `await whenIdle()` between batches
(`server/lib/interactive.js:44`) — state-driven, no settle window to tune, holds
for precisely as long as the user is being served. Sweeps are kicked off
fire-and-forget after a scan (`server/api.js:630-633`) and are cancelable from
the JobsPanel like any other job.

### 3. Inputs: embed the thumbnail, never the original

Vision encoders take 224×224. The cache already holds a 320px JPEG for anything
the user has looked at (`GET /api/thumb/:id`, `server/api.js:866`, buckets
`[160, 320, 480, 640, 1024]`), so the embedding input is a ~30 kB decoded read
instead of a 25 MB one — and for RAW it is the _only_ workable input, since
`extractPreview` throws for RAW and the full decode path was never built.

The thumb-cache key formula (`sha1(path:mtime:size:size)`) is currently
hand-duplicated in `server/api.js:872` and `server/lib/cacheStats.js:19`, with a
comment admitting it is "kept in sync manually". **Extract
`thumbCachePath(photo, size)` into `server/lib/cachePaths.js` and make all three
callers use it** rather than becoming the fourth copy.

⚠️ `pruneOrphanedCache` (`cacheStats.js:147`) deletes any file under `thumbs/`
not in its expected key set, regardless of extension. Model files and vector
sidecars go in their own directories.

### 4. Storage

Embeddings live in **their own table**, not a column on `photos`:

```sql
CREATE TABLE photo_embeddings (
  photo_id INTEGER PRIMARY KEY REFERENCES photos(id),
  model TEXT NOT NULL,   -- upgrading the model is new rows, not a migration
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,     -- int8-quantized + scale; see below
  created_at INTEGER
);
```

The feed's hot path is `SELECT photos.*` over a keyset seek. A 2 kB blob per row
would be dragged through every page fetch, every tree count, and every group
sample for no benefit. Faces likewise get `photo_faces` + `persons`.

**Single-valued signals that must be group dimensions get denormalized columns on
`photos`** via the existing `ensureColumn` pattern (`schema.js:181`): `lat`,
`lon`, `place_country`, `place_admin1`, `place_city`, `semantic_cluster`. This is
not duplication for convenience — see §5.

**Multi-valued signals reuse `tags` / `photo_tags`**, which are already in the
schema (`schema.js:53-64`) and used by nothing. `tags(dimension_name, value)` is
literally keyed by the dimension-registry name, and `photo_tags.source`
distinguishes model output from a manual edit — so a user correction survives the
next sweep. They were designed for this.

**No vector database.** 114k × 512 float32 is 234 MB; int8-quantized with a
per-vector scale it is 58 MB, which loads into one typed array. A brute-force
cosine scan is ~58M multiply-adds — well under 100 ms, and it runs in the sidecar,
off the event loop. `sqlite-vec` is the escape hatch if that stops being true,
not the starting point.

**Invalidation.** `upsertScan`'s `ON CONFLICT` (`server/db/photos.js:39-43`)
currently nulls `content_hash` when size or mtime changed and nothing else — so a
replaced file keeps its old `width`, `taken_at`, and `camera`. Every ML artifact
must be added to that `CASE`, or an edited photo keeps a stale embedding forever.

### 5. Reaching the feed — one hard constraint

`server/db/feed.js:53-77` states the invariant: the keyset seek assumes **one
value per photo per dimension**. `seekCondition`, `compareKeyTuples`, and
`spliceInPlaceholders` all depend on it. That single fact decides how each signal
surfaces:

| Signal                  | Cardinality    | Mechanism                                                                  |
| ----------------------- | -------------- | -------------------------------------------------------------------------- |
| Place, semantic cluster | one per photo  | `DIMENSIONS` entry over a denormalized column + generated expression index |
| Person, semantic tag    | many per photo | filter facet only, phrased `photos.id IN (SELECT …)`                       |
| Similarity to an anchor | a relation     | neither — its own feed path                                                |

The subquery phrasing is not a style preference. `keepScope`
(`server/db/filters.js:69-71`) and `folderPath` (`:87-93`) are both written that
way **because the feed-seek and tree queries do not JOIN extra tables** — a facet
written as a JOIN works in `getFeedPage` and silently breaks `getTreeNode`,
`countGroupPath`, and the other seven `buildFilter` consumers.

A new filter facet is three layers or it is nothing:
`server/db/filters.js` (SQL) → `parseFilterParam` allowlist in `server/api.js`
(:340-444) → `ui/src/lib/filterSpec.js` (client). `server/api.js:371-372` carries
the warning verbatim: a facet missing from the allowlist is silently dropped,
however correct the SQL and the UI are. `KindFilter` is the cleanest end-to-end
template.

A new group dimension is `DIMENSIONS` (`server/db/feed.js:24`) +
`ALL_DIMENSIONS` (`ui/src/lib/dimensions.js:10`) + a label branch in **both**
`formatTreeLabel` (`server/db/tree.js:103`) and `formatGroupValue`
(`ui/src/lib/feed.js:25`) — twins with no shared module — plus an expression
index and `queryPlan.test.js` coverage, or the feed slides back to full scans
with no failing test.

### 6. Similarity — two shapes, because it has two uses

Similarity has no value to sort by; "similar" is only defined against an anchor.
So it gets both available shapes rather than pretending to be one:

- **Semantic clusters** — cluster the embeddings once, write `semantic_cluster`
  as a single-valued column. That _is_ a legal group dimension: browsable,
  foldable, and navigable exactly like folders, with zero new feed paths. This is
  the "photo ring" reading of similarity.
- **Anchored "more like this"** — from the loupe, re-rank against one photo's
  vector. This is a lookup, needs its own feed path (closer to `startPath` /
  `scopeIds` than to a `SORT_ATTRS` entry), and is the precise tool the cluster
  view cannot be.

**Near-duplicates suggest, they never act.** A near-dupe group becomes a
_suggested_ burst stack flowing through the existing `stackOverrides` seam
(`ui/src/lib/stackOverrides.js:28` — "the single seam"), so it is accepted or
rejected like a manual stack. Nothing is moved and nothing is deleted. Note
`ui/src/lib/bursts.js:86-92`: stacks are always clustered chronologically
regardless of the active sort, and a semantic stack has no such ordering — that
interaction needs deciding at the issue, not here.

### 7. The view contract — pluggable replacements for the feed

The scatter is not a one-off. `2026-07-06-photo-triage-design.md:129-131` and
`ROADMAP.md:36-41` already name three future implementers — "quantum treemap,
zoomable timeline, CLIP-embedding scatter" — so the deliverable is **a registry
and a contract**, of which the scatter is one client and not the first. Building
the scatter as a special case would guarantee the treemap re-derives all of it.

The precedent is `ui/src/lib/groupRenderers.js:1-40`, whose whole design note is
"adding a new widget is now: write a Svelte component that takes `{group, rect,
params}`, and add one entry to `GROUP_RENDERERS`". This is that idea raised from
a group band to the entire main area.

#### Three scales of pluggability — only the middle one exists

The same registry idea applies at three nested scales, and naming them separately
keeps the work from colliding:

| Scale          | What swaps                  | Registry                    | Status        |
| -------------- | --------------------------- | --------------------------- | ------------- |
| **View**       | The entire main area        | _(new)_ `views/registry.js` | **missing**   |
| **Group band** | How one group's photos draw | `groupRenderers.js`         | **exists** ✅ |
| **Tile**       | How one photo draws         | _(new)_ `tileRenderers.js`  | **missing**   |

**The group-band registry is already built and is good** — shipped in 2.9.18,
refined in 2.9.26, spec'd at
`docs/superpowers/specs/2026-07-12-group-photo-renderers.md`. It holds
`GRID` / `SNAPSHOT` / `COLLAPSED` plus two aggregate variants for #142, with a
clean `needsFeedPhotos` split between "photos stream into the feed" and "the
widget draws its own band from its own sampled data". Nothing about it needs
redesigning.

Its real gap is that **only one entry actually draws anything** — `SnapshotStrip`
is the sole component; `GRID` and `COLLAPSED` are both `component: null`. A
registry validated by a single widget is an untested abstraction, and the
`needsFeedPhotos: false` path (draw your own band from your own sample, already
served by `GET /api/group/sample`) is exactly where a map band, a time-density
band, or a per-group similarity band would slot in with no new machinery.

**The tile scale is the one that isn't modular at all.** `Thumb.svelte` is 611
lines, imported directly by five call sites (`App.svelte`, `SnapshotStrip`,
`SnapshotThumb`, `LoupeFilmstrip`, `BurstOverlay`), and is the single hardcoded
answer to "how does a photo draw". Alternative tile treatments — a metadata card
showing camera and settings, a dense contact-sheet cell, a face-crop tile once
faces exist, a place tile — have nowhere to go today. This is a smaller and more
independent piece of work than the view registry, and it directly relieves the
same #124 pressure.

#### Two tiers, one registry (view scale)

Not every view can be a pure layout, and pretending otherwise is where this
would go wrong:

- **Layout views** are a pure function `layout(items{id, aspectRatio}, viewport)
→ [{id, x, y, w, h}]` — the existing contract, alongside `justified.js` and
  `sectionedJustified.js`. They ride the existing virtualized scroller, group
  headers, selection, and `loadMore` unchanged. **Treemap and time-layout are
  this.** A treemap is `(weights, rect) → rects`, and the founding design's
  "quantum treemap" is exactly the variant that keeps thumbnails at usable
  aspect ratios.
- **Canvas views** own their own navigation model. **Scatter is this**: it
  zooms and pans, and there is no scroll position to virtualize against. It
  cannot be a layout function without lying about what a viewport is.

One registry holds both; a layout view is simply the common implementation that
adapts a pure layout function to the contract:

```js
// ui/src/lib/views/registry.js
{
  id: "treemap",
  label: "Treemap",
  icon: …,
  navigation: "scroll" | "zoom",   // who owns the viewport
  dataSource: "feed" | "working-set",
  component,                       // takes { items, viewport, selection, callbacks }
}
```

Every view receives the same props and the same callbacks —
`onOpen(loupe)`, `onSelect`, `onRate` — so **rating, selection, and the loupe
keep working in every view without each one re-implementing them**. A view that
cannot support one of them declares it, rather than silently dropping the
keystroke; a keyboard-first app where `3` rates in one view and does nothing in
another is worse than a missing view.

#### The constraint that decides `dataSource`

`items` in `App.svelte` is a **sliding window**, not the library. It is extended
by `loadMore` and replaced by `withFeedTransaction`, and CLAUDE.md is explicit
that a new case must extend one of those two rather than opening a third — six
hand-copied versions of that guard caused two shipped bugs (#35, #36, #39).

A grid is fine with a window because scrolling _is_ the window. **A treemap or a
scatter over "the library" is not** — a treemap of the current 200-row window is
a treemap of nothing meaningful, and it would reshuffle every time the user
scrolled.

So whole-library views declare `dataSource: "working-set"` and fetch their own
bounded dataset, **exactly as the album timeline already does**:
`workingSetTimeline` (`server/db/feed.js:913`) returns the filtered working set
capped at 2,000 with a `truncated` flag. That is the established answer to "I
need all of it, not a page", it respects the active filter, and it touches
neither `loadMore` nor `withFeedTransaction`. The cap and the truncation
affordance are per-view decisions; the mechanism is shared.

#### The modularity payoff — and the boundary that makes it safe

This is the main argument for the registry, independent of any ML. `App.svelte`
is **6,456 lines** and #124 ("refactor App.svelte") has stayed open because it
has no natural seam — "make it smaller" is not a task anyone can start. Adding a
treemap, a time view, and a scatter as more branches inside it would take it past
8,000 and make #124 permanently untouchable.

The view contract _is_ that seam. Each view becomes its own component with its
own layout module and its own tests, and the grid — today the implicit,
unnamed default tangled through App — becomes the registry's first client,
named and bounded like the others. Every subsequent view is then additive: a
new file and one registry entry, not another branch in a file nobody can hold
in context.

The boundary has to be drawn precisely, though, or this trades one problem for a
worse one:

| Stays in `App.svelte`                                                                | Moves into the view                          |
| ------------------------------------------------------------------------------------ | -------------------------------------------- |
| The feed window `items` and its two transactions (`withFeedTransaction`, `loadMore`) | Layout, rendering, hit-testing               |
| Filter / sort / groupBy state and persistence                                        | View-local interaction (zoom, pan, hover)    |
| Selection state and rating mutations                                                 | How selection is _displayed_                 |
| Keyboard dispatch                                                                    | View-specific keys, declared to the registry |

**App stays the data owner.** Views are consumers that receive `items` and emit
intent through callbacks. The feed-window guard pattern is the one thing that
must not be distributed — CLAUDE.md is explicit that six hand-copied versions of
it caused two shipped bugs, and a per-view copy would be the seventh. A view that
needs different data asks for `dataSource: "working-set"` and gets its own bounded
fetch; it never touches `items`.

Extracting the grid is therefore a refactor with **no user-visible change**, which
makes it verifiable: same fixture, same e2e specs, green before and after. Do it
first and alone, before any second view exists to muddy the diff.

#### Rendering

Above a few thousand visible items the renderer, not the layout, is the
constraint. `AlbumTimeline.svelte:121-125` records both the measurement and the
answer — canvas redraws 20,000 dots in about a millisecond, where that many SVG
elements jank — and `albumTimeline.js`'s `hitAt` records the discipline:
**hit-testing lives in a pure, tested module, so hover and click cannot
disagree.** Every canvas view follows that split. #10 (GPU archive overview,
regl/deck.gl + texture atlases) is the next tier up and stays out of scope.

Note the ordering consequence: the treemap and time views need **only the view
contract**, not embeddings. They can ship before any model exists, and they are
what proves the contract is real — a contract with one implementation is a
guess.

### 8. Places need no ML at all

`exifr` already reads GPS. The extraction call at
`NodeProcessingService.js:330-342` simply has a nine-tag `pick` allowlist that
omits it, so the data is never read off disk. Add the GPS fields, store `lat` /
`lon`, and reverse-geocode offline.

**Shipped, then corrected (#154 → #175).** The first implementation used
`offline-geocode-city` (217 kB, S2-cell, ~0.035 ms/lookup). Its dataset is
UN/LOCODE — a _shipping_ list, not a gazetteer — and it turned out to contain no
entry at all for San Francisco, Oakland, Berkeley, San Jose or Palo Alto, so
Bay Area photos resolved to unrelated towns up to 33 km away. Replaced with
`all-the-cities` (138k GeoNames places, pop ≥ 1000, bundled, MIT). Two lessons
worth carrying into the remaining place work:

- **A dense gazetteer alone is not enough.** Plain nearest-neighbour over it
  answers "Mission District" or a 2,000-person barrio rather than the city, so
  `place.js` scores `distance − 2 km × log10(population)`. Prominence must
  offset distance without overriding it, or genuinely distinct neighbours
  (Sausalito, Berkeley, La Calera) get absorbed into their big neighbour.
- **Derived place names need a version.** `gps_checked` is permanent, so
  improving the geocoder cannot rely on the sweep revisiting rows — see
  `PLACE_VERSION` / `backfillPlaces`.

GeoNames `featureCode` also carries the levels this design still wants:
`PPLX` rows are neighbourhoods (Castro, Union Square — #176) and `adminCode`
gives admin1 for the state/region level (#173), both from data already loaded.

⚠️ Verify the exifr option combination during implementation: `pick` restricts
the parse, and the GPS block may need `gps: true` (or a separate `exifr.gps()`
call) to be emitted at all. This is the kind of thing that silently returns
`undefined` rather than throwing.

Hierarchical place is single-valued per photo, so it maps straight onto the
existing dimension machinery and the Library tree with no new concepts — which is
exactly why it goes first. It proves the full new-dimension path (columns →
`DIMENSIONS` → expression index → tree labels → filter facet → three layers) with
no runtime, no packaging risk, and no model.

## Data flow

```
scan ──▶ upsertScan ──▶ (post-scan, fire-and-forget)
                          │
                          ├─▶ enrich sweep      (exists) → EXIF + dims + GPS
                          └─▶ ml sweeps         (new)
                                │  await whenIdle() between batches
                                │  worklist = partial index
                                ▼
                        OnnxMLService ──stdio──▶ child process
                                │                  transformers.js + ORT
                                │                  input: 320px cached thumb
                                ▼
              photo_embeddings / photo_faces / photo_tags / photos.place_*
                                │
        ┌───────────────┬───────┴────────┬──────────────┬─────────────┐
        ▼               ▼                ▼              ▼             ▼
   place dim      semantic_cluster   person facet   tag facet     UMAP x/y
   + facet        (group dim)        (subquery)     (subquery)        │
                       │                                              │
                       └─▶ near-dupe groups ─▶ suggested stacks       │
                                               (stackOverrides)       │
                                                                      │
  App.svelte ── items / selection / callbacks ──▶ VIEW REGISTRY ◀──────┘
                (App owns the feed window; views never touch it)
                        │
        ┌───────────────┼────────────────┬──────────────────┐
        ▼               ▼                ▼                  ▼
      grid           treemap         time view           scatter
   (layout)         (layout)         (layout)        (canvas, zoom/pan,
                                                      working-set fetch)
```

## Never fail silently

Per the usability contract, each of these is a visible, specific, actionable
message — not a console error and not a dead control:

- Model download failed / offline → what was being fetched, how big, and a retry,
  on the control that triggered it.
- Sidecar crashed or won't start → say so once, name the stage, offer retry;
  the app stays fully usable without ML.
- A photo permanently failed a stage → it leaves the pending set (sentinel) and
  is _countable_, so "12,431 of 114,125 embedded, 37 failed" is reportable rather
  than an unexplained shortfall. This is the reason the `ml_status` table exists,
  and it is the specific way pre-2.17.14 `backupCoverage` misled.
- **A sentinel must distinguish "this photo cannot be processed" from "the drive
  was not there".** The first is a permanent property of the photo; the second is
  a property of the moment, and on a library that lives on a removable drive it
  is the common case. Conflating them is #169: an unmount mid-sweep marked every
  unreachable file attempted, and nothing clears that unless the file's bytes
  change. `ml_status.attempts` + the error string exist so an ML stage can retry
  a transient failure and give up only on a durable one.
- Sweep progress and completion go through the JobsPanel like every other job,
  with a per-type summary branch (`JobsPanel.svelte:134-178`).
- An empty result from a person/tag/similarity filter must read as "no matches"
  distinctly from "not computed yet" — the pending count is the difference, and
  the empty state must say which.
- A view that needs data nobody has computed yet (the scatter, before embeddings
  exist) must say so and offer to start the sweep — not render an empty canvas.
- Switching views is a keyboard action, so it lands in
  `ui/src/lib/ShortcutsOverlay.svelte` in the same commit, and every view
  declares which keys it handles so the overlay can reflect the active view.

## Testing

Per the testing contract, at the tier that would catch it:

- **vitest, pure** — quantization round-trip and cosine distance; clustering
  determinism given a fixed seed; the scatter layout function (pure, like
  `justified.js`); the sweep loop with a fake `process` that fails on a chosen
  row, asserting the sentinel is written and the loop still drains; place
  hierarchy formatting.
- **vitest, db** — new facets in `server/db/filters.test.js`; the allowlist in
  `server/api.test.js`; **`queryPlan.test.js` for every new group dimension**, or
  the index rots silently. Destructive index tests use a temp `AUTOGALLERY_HOME`.
- **e2e** — the seam cases, which is where this app's shipped bugs live: a filter
  facet that works in the feed but breaks the tree counts; a group dimension whose
  server and client labels disagree; `trackPageErrors(page)` in every spec.
- **Sidecar** — contract-tested against a stub `MLService` so the suite never
  downloads a model or spawns a child process.
- **Views** — each layout is a pure function, so treemap and time layouts are
  vitest tests with no DOM (rect coverage, no overlap, stable under reorder).
  The registry gets a conformance test: **every registered view is mounted
  against the shared fixture and must support selection, rating, and loupe entry
  or explicitly declare it doesn't** — that is what stops view #4 from quietly
  dropping the `3` key. The grid extraction ships with the existing e2e specs
  green and unmodified; if a spec needs changing, the extraction changed
  behaviour and is wrong.

Prefer extending the shared fixture over a bespoke setup per slice.

## Out of scope

- GPU/WebGPU inference, and the GPU archive-overview renderer (#10).
- Any cloud or paid API. Local only — the #79 constraint applies program-wide.
- Writing ML results back into the files' EXIF (see #34 for the ratings analogue).
- Video: embeddings cover the poster frame only, if at all. Decide per issue.
- Pick prediction / aesthetic ranking (the other half of Phase 2).

## Issue map

Ordered by dependency. **Four are unblocked today** — places, the view contract,
the tile registry, and the sidecar are mutually independent, and the whole
modularity track needs no models at all.

| #    | Slice                                                                 | Depends on | Relates              |
| ---- | --------------------------------------------------------------------- | ---------- | -------------------- |
| #154 | GPS extraction + offline reverse geocoding + place dimension          | —          | —                    |
| #155 | View contract + registry (grid becomes its first client)              | —          | **#124**             |
| #156 | Photo treemap view                                                    | #155       | —                    |
| #157 | Time-based view                                                       | #155       | #98                  |
| #158 | Tile renderer registry (extract `Thumb.svelte`) + a 2nd tile          | —          | **#124**             |
| #159 | More group-band renderers (2nd real widget for the existing registry) | —          | —                    |
| #160 | ML sidecar foundation + generalized idle sweep                        | —          | #67 (ABI), #136, #94 |
| #161 | Image embeddings over cached thumbnails                               | #160       | —                    |
| #162 | Near-duplicate detection → suggested stacks                           | #161       | #14, #86, #12        |
| #163 | Semantic clusters + "more like this"                                  | #161       | #17                  |
| #164 | Open-vocabulary scene tags (zero-shot, text encoder)                  | #161       | #79                  |
| #165 | Embedding scatter view (UMAP)                                         | #155, #161 | #10                  |
| #166 | Face detection + embedding                                            | #160       | —                    |
| #167 | Face clustering, naming, person filter                                | #166       | —                    |

**Three independent tracks**, meeting only at the scatter (#165):

- **Modularity** — #155 → #156, #157 (view scale); #158 (tile scale); #159 (group
  scale). No models, no packaging risk, and it is the standing answer to #124.
- **Signals without ML** — #154 (places).
- **ML** — #160 → #161 → #162, #163, #164 / #166 → #167.

The modularity track deliberately ships real second implementations at each scale
before the ML views need them, because a registry validated by one client is a
guess — which is precisely the state `GROUP_RENDERERS` is in today.

## Resolved decisions (approved 2026-07-24)

- **Runtime: JS/ONNX in a child process.** Not in-process (blocks the loop, a
  segfault kills the app), not a Python sidecar (100–200 MB of runtime on top of
  an unresolved arch matrix and no code signing). `MLService` keeps the Python
  swap open, as `ProcessingService.js:11` always intended.
- **Places ship first** — no model, no packaging risk, and it de-risks the
  new-dimension plumbing every later slice depends on.
- **Face models: non-commercial licences acceptable, downloaded not bundled.**
  `buffalo_l` is the accuracy leader and is research-use-only; opt-in download
  with the licence shown keeps the shipped binary clean.
- **Similarity gets both clusters and an anchored mode** — the cluster is the
  browsable dimension, the anchor is the precise lookup; neither substitutes.
- **Views are a registry, not special cases.** The scatter, treemap, and time
  views are three clients of one contract. It is also the seam that makes #124
  tractable: each view is its own module rather than another branch in a
  6,456-line `App.svelte`. App keeps owning the feed window; views never do.
- **Pluggability is three registries at three scales** — view, group band, tile.
  The group-band registry already exists and is sound; it is not redesigned, it
  is given a second real widget. The tile scale (`Thumb.svelte`, 611 lines, five
  direct importers) is extracted separately and can proceed in parallel.
- **Near-duplicates suggest stacks, never act.** Nothing moved, nothing deleted.
- **No vector database.** Brute-force over quantized vectors until measurement
  says otherwise.
- **Stay on SQLite / better-sqlite3 — do not migrate to DuckDB.** See below.

## Why not DuckDB (asked and answered 2026-07-24)

DuckDB is the obvious candidate for this work — native `FLOAT[N]` arrays,
`array_cosine_similarity`, an HNSW extension, and columnar execution for the
aggregate-heavy treemap/scatter/density queries. It is still the wrong move, for
four reasons, and this is recorded so it is not relitigated from first
principles later.

**1. It is a data-layer rewrite, not a driver swap.** `@duckdb/node-api` is
Promise-first (the callback client is deprecated as of DuckDB 1.5.x);
`better-sqlite3` is synchronous, and this codebase depends on that at **69
`db.prepare` / `.transaction()` call sites across 14 server files**. A
better-sqlite3 `db.transaction(() => …)` is synchronous _by contract_ — you
cannot await inside one — which is exactly what makes `enrichBatch` and
`upsertScan` crash-safe. Every one of those would need redesigning, not porting.

**2. The feature we would migrate _for_ is the one DuckDB is least ready for.**
Persistent HNSW is experimental, gated behind
`hnsw_enable_experimental_persistence`, and **WAL recovery is not implemented for
custom indexes** — an unclean shutdown can corrupt the index or lose data, and
the DuckDB docs warn against relying on it in production. For a desktop app that
gets force-quit, that is disqualifying. And per §4 we do not need ANN anyway: 58 MB
of int8 vectors brute-forced in the sidecar is well under 100 ms, off the event
loop.

**3. The workload is the wrong shape.** The hot path is not analytical — it is a
keyset-paginated point lookup ("200 rows after this key, ordered by these four
dimensions"), which is what B-tree expression indexes are best at. `sort.js:149-170`
records the measured wins: 33 ms → 0.2 ms, 224 ms → 17 ms, tree counts 18 ms →
0.4 ms. DuckDB has no comparable secondary B-tree story (it leans on zone maps),
so the likely outcome is the _primary_ workload regresses to speed up a secondary
one that is not a bottleneck. We would also have to re-engineer the `sort_path`
generated column, the fingerprinted expression indexes, the partial indexes, the
`PRAGMA table_xinfo` migration helper, and the `EXPLAIN QUERY PLAN` assertions in
`queryPlan.test.js` that are the only guard against silent index rot.

**4. Two costs that are easy to under-count.** It is another native addon
(#67's ABI trap and #136's arch matrix, doubled, at the same moment we add
`onnxruntime-node`). And **not all of the index is rebuildable**: invariant 2
holds for derived columns, but `rating`, `keep_scope`, `manual_stacks`,
`preferred_cover`, `dismissed`, and album names are real user data with no source
on disk, so a migration has to carry them correctly, once, with no second chance.

### The trigger conditions that would change this answer

- **~1M+ photos.** At 1M, int8 vectors are ~512 MB and brute force stops being
  free. That is when ANN indexing earns its keep.
- **Ad-hoc analytics outgrowing SQLite** — if the treemap/scatter/density
  aggregates stop being comfortable.

If either lands, the move is still **not** migration. It is DuckDB as a
**second, read-only, derived store inside the ML sidecar** — rebuildable from
SQLite, never the system of record. That preserves invariant 2, leaves ratings
where they are, and costs no rewrite.
