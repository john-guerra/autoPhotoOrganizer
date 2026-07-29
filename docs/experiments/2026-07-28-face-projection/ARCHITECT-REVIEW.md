# Architecture review — the face projection view (#232, seam for #165)

Produced 2026-07-28 by a `feature-dev:code-architect` pass over the design in
this folder, reviewed against `CLAUDE.md`, `docs/UI-CONTRACTS.md`,
`docs/AGENT-NOTES.md`, `docs/TESTING.md` and the measurements in `README.md`.

Two claims in it were independently re-verified before it was filed:

- **umap-js's licence.** Confirmed: the shipped package's `LICENSE` is the
  Apache License 2.0 and `src/umap.ts` carries
  `Copyright 2019 Google LLC … Licensed under the Apache License, Version 2.0`,
  while `package.json` says `"license": "MIT"`. The file and headers control.
  `README.md` in this folder has been corrected.
- **`@keckelt/tsne`'s licence.** Confirmed MIT via the registry.

Everything below is the architect's output, verbatim.

---

## 10-line summary

1. **`minFaces: 2` should be the DEFAULT run parameter** — 5,499 points not 25,758. It cuts `initializeFit` from 14.1s to ~2s, peak RSS from 1,825MB to ~750MB, and makes t-SNE affordable. It dissolves the progress problem, the memory problem and the algorithm-menu problem at once.
2. **umap-js is Apache-2.0, not MIT** — its `package.json` says MIT but the `LICENSE` file and every source header are Apache-2.0. Decision 4's rationale is factually wrong, and the licence axis was load-bearing enough to reject DruidJS.
3. **Decision 7 contradicts decision 6**: a "client-side" min-faces filter cannot coexist with `member_filter` in the run cache — and decision 7's own maths argument proves it must be the run parameter.
4. **Two-phase progress is acceptable** (§2 forbids indeterminate against a _known_ total; here it isn't knowable) — but `nEpochs` must be an explicit param so `total` is set at `registry.create`. `setPrecomputedKNN` is a trap: exact kNN in 512-d is ~123s vs 14.1s.
5. **The packaging risk does NOT transfer from #203** — that verified a spawned `ELECTRON_RUN_AS_NODE` child; this is a Node worker thread _inside_ Electron's main process, a different asar path. Verify, then `asarUnpack` only if needed.
6. **`resourceLimits.maxOldGenerationSizeMb` is the strongest un-stated argument for `worker_threads`**: it turns an OOM crash into a catchable, actionable job failure.
7. **Do not loop `mergePersons`** — the target's `person_source` re-mark is O(N × target faces). Write `mergePersonsBulk`. Two differently-named persons must be an explicit user choice, never `into.name || from.name`.
8. **The undo record's forgotten field is per-face `person_source`** — restoring `person_id` alone freezes those faces as manual forever.
9. **Decision 8's `open: false` is probably wrong**, and the real gap is that the registry has no field for view-local keys — `X` will tell the user "Selecting photos isn't available" while the view has a fine selection of people.
10. **Cut from v1**: the algorithm menu, streaming layout, JL reduction, a run browser, an atomic merge-and-name endpoint.

---

Reviewed 2026-07-28 against `CLAUDE.md`, `docs/UI-CONTRACTS.md`, `docs/AGENT-NOTES.md`, `docs/TESTING.md` and the measurements in this folder's `README.md`. Written to be actionable: every claim names the file and function it lands in.

The design is fundamentally sound. Three of the nine stated decisions are wrong or under-specified, one library fact is wrong, and one default choice — not currently stated as a decision at all — dissolves the three hardest problems at once. Those come first.

---

## 0. The three findings that change the shape of the work

### 0.1 `minFaces: 2` should be the DEFAULT, and it dissolves most of this design

The README already contains the answer and does not draw the conclusion: 20,259 of 25,758 persons are singletons, "mostly strangers in the background of one photo, **and not merge candidates**". The working set is the 5,499 persons with ≥2 faces.

Project 5,499 points instead of 25,758 and every hard constraint relaxes at once, using this folder's own measured numbers:

|                                        | 25,758 points        | ~5,500 points (interpolating the 3,000-point row) |
| -------------------------------------- | -------------------- | ------------------------------------------------- |
| `initializeFit` (the unyieldable call) | **14.1 s**           | **~2 s**                                          |
| total UMAP                             | 20.5 s               | ~4 s                                              |
| peak RSS                               | 1,825 MB             | ~750 MB                                           |
| t-SNE                                  | ~47 min (infeasible) | ~2 min (affordable)                               |

Consequences, in order of importance:

1. **The two-phase progress problem mostly goes away.** A 2-second unreportable phase is not a hang; a 14-second one is. See §2.3.
2. **The OOM risk goes away.** 1,825 MB peak on an 8 GB laptop while Electron, Chromium and libvips are also resident is not comfortable. 750 MB is.
3. **The algorithm menu becomes honest.** t-SNE scores 62.5% twin-is-#1 against UMAP's 27.8% on the hard split — 2.2× better at the actual task. At 5,500 points it is a real choice. At 25,758 it is a menu item that wedges the app for 47 minutes.
4. **The dots that vanish are exactly the dots that are noise for this task.** A singleton person cannot be "one human split across many person-groups"; it is one face seen once.

So: `minFaces` defaults to **2**, is a run parameter (`projection_runs.member_filter`), and `minFaces: 1` is offered explicitly with its cost quoted — "include people seen once (25,758 dots, about 20 s, needs ~2 GB)". That sentence is also how this feature satisfies contract 1 (§6.1).

### 0.2 umap-js is **Apache-2.0, not MIT** — decision 4's stated rationale is wrong

Verified 2026-07-28:

- `package.json` in `PAIR-code/umap-js@main` says `"license": "MIT"`.
- The repository `LICENSE` file is the **Apache License 2.0** verbatim.
- Every source file carries `Copyright 2019 Google LLC … Licensed under the Apache License, Version 2.0`.

The per-file headers and the LICENSE file control; the `package.json` field is upstream's mistake. Apache-2.0 is permissive and perfectly compatible with shipping inside an MIT-licensed app — but it is **not** MIT, and it carries obligations MIT does not: §4 requires retaining the copyright notice, the licence text, and any NOTICE file in redistributions. This app ships a packaged Electron binary, i.e. it redistributes.

This matters more than usual here because the _entire_ stated reason for rejecting DruidJS was licence (LGPL-3.0-or-later vs. "this repo's MIT"). If the licence axis is load-bearing enough to reject a library, the labels on the libraries you kept have to be right.

**Action:** correct the README's "umap-js (MIT)" line, and add a third-party notices surface. There is currently none — if nothing exists, this feature is the one adding the first Apache-2.0 dependency and should add a `THIRD-PARTY-NOTICES.md` packed via `build.files`. Also verify `@keckelt/tsne`'s licence before adding it (I could not confirm it from the registry; it is a TypeScript port of Karpathy's tSNEJS, which is MIT, but a port's licence is the port's to declare). `ml-pca` is MIT (mljs). Note §8 recommends cutting both from v1 anyway, which makes this a non-issue for now.

### 0.3 Decision 7's "client-side minimum-faces filter" contradicts decision 6

Decision 7 says the min-faces control is a **client-side filter**. Decision 6 puts `member_filter` in `projection_runs`, i.e. a **run parameter**. Decision 7's own justification ("a UMAP of a subset is not a subset of the UMAP") proves it must be the run parameter: if it were client-side, dragging the slider would hide dots without re-laying-out, and the remaining dots' positions would still encode 20,259 singletons pulling on the graph. That is precisely the artefact the decision says to avoid, and the user would see a map that does not change shape as they filter.

**Resolve as:** `minFaces` is a run parameter, part of the cache key, and changing it starts a job (which is instant when that run is cached). A _separate_ client-side control may exist for cosmetic hiding (e.g. "hide named people"), but it must be visually distinguished — one control that sometimes re-runs a job and sometimes does not is the worst of both.

---

## 1. Build sequence

Nine tasks (plus one optional). Each ends at a committable, independently testable state; none requires the next to be useful. Tiers per `docs/TESTING.md`: push logic down, reach for Playwright only where the bug lives in the DOM or between modules.

### Task 1 — person centroids in the data layer

**Deliverable:** `personCentroids(db, model, { minFaces })` in `server/db/faces.js`, returning `{ ids: Int32Array, dim: number, data: Float32Array }` — one flat buffer, exactly the layout `faceVectors` already uses and for the same GC reason stated at `server/db/faces.js:216`.

Dequantize with `dequantize(bytes, scale)` (`server/ml/quantize.js:50`), mean per person, re-normalize to unit length. `ORDER BY p.id` — **deterministic member order is load-bearing**: the run cache is keyed by params, and UMAP is order-sensitive, so two "identical" runs with different row order produce different maps.

**Tier 1 (vitest), new `server/db/personCentroids.test.js`:**

- a person with two known vectors yields a unit-norm centroid;
- `minFaces: 2` excludes singletons and `minFaces: 1` includes them;
- a person row with zero faces (a named person whose faces were all detached — a real state, see `saveClusters`' PROTECTED clause) is excluded, not returned as a NaN point;
- mixed `dim` throws, mirroring `faceVectors`' own guard;
- the returned id order is stable across two calls.

No user-visible change. Commit.

### Task 2 — the projection worker, standalone

**Deliverable:** `server/projection/worker.js` (the `worker_threads` entry) and `server/projection/runProjection.js` (the supervisor the API will call). Full protocol in §2. `umap-js` added to `dependencies`.

**Tier 1 (vitest), `server/projection/runProjection.test.js`:**

- 300 synthetic points in 3 obvious clusters → 3 separable 2-D clusters (assert via a cheap silhouette-ish check, not exact coordinates);
- **determinism**: same seed, same input, twice → byte-identical `Float32Array`. This is what makes the cache correct; without it the cache serves a map that differs from what a re-run would produce;
- **cancellation**: abort mid-run → resolves as canceled, `worker.terminate()` was called, no coordinates written;
- **error propagation**: a worker that throws surfaces a real `Error` with the original message;
- **double-settle**: a worker emitting both `error` and `exit` settles once (the `#killChild` lesson at `server/ml/OnnxMLService.js:169` — copy the identity-keyed idempotence, do not re-derive it).

Note: umap-js's `random` option takes a _function_, so determinism requires supplying a seeded PRNG. Hand-roll a 4-line mulberry32 in the worker rather than adding a dependency (`d3-random`'s `randomLcg` would also work but drags d3 into a server module for no reason).

This tier is free protection against the AGENT-NOTES "vitest green, node refuses to load" trap: the test _spawns the worker under real Node_, so a Vite-only-loadable module fails here.

Also run, once, and record: `npm ls --omit=dev umap-js` — its only runtime dependency is `ml-levenberg-marquardt`; confirm no build toolchain rides along (the `smart-labels` / `offline-geocode-city` failure mode).

### Task 3 — the run cache

**Deliverable:** two tables in `server/db/schema.js` and `server/db/projections.js` with `findRun`, `createRun`, `savePoints`, `pointsForRun`, `pruneRuns`. Schema critique in §5.5.

**Tier 1:** `server/db/projections.test.js` — a run round-trips; `findRun` matches on the full key and misses on any one field; `pointsForRun` INNER JOINs `persons` so a deleted person's point vanishes; `pruneRuns(3)` keeps the newest three. Plus one assertion in `server/db/queryPlan.test.js`: `pointsForRun` must plan as a `run_id` prefix scan on the `WITHOUT ROWID` primary key, not a scan of every run's points.

### Task 4 — the route and the job

**Deliverable:** `POST /api/projections` → `{ jobId }` or `{ reused: runId }`; `GET /api/projections/:id/points`; `"projection"` added to the `JobType` union at `server/jobs/registry.js:3`; a `summarize()` branch in `ui/src/lib/JobsPanel.svelte`; `withProjectionLatch` mirroring `withClusterLatch` (`server/ml/faceClusters.js:140`).

**Tier 1:** `server/projectionRoutes.test.js`, modelled on `server/faceRoutes.test.js:168` ("is a JOB, not an awaited result"). Assert: every refusal is a synchronous 4xx **before** `registry.create` (no zombie row); a second concurrent request 409s; an already-computed run returns `{reused}` with no job at all; cancel lands as `status: "canceled"`, not `"failed"`.

Curl-verifiable, no UI. Commit.

### Task 5 — the pure scatter core

**Deliverable:** `ui/src/lib/scatter/` — `transform.js`, `hit.js`, `lasso.js`, `lod.js`. Pure, DOM-free, d3 allowed (the `albums.js` precedent). Contract in §4.

**Tier 1:** `ui/src/lib/scatter/scatter.test.js`. This is where the lasso's correctness lives: a self-intersecting polygon, a point exactly on an edge, a polygon with < 3 points, a 25,000-point set benchmarked so the lasso is proven sub-frame. Plus one structural assertion: **the module must not import anything from `api.js`, and must not contain the strings "person" or "face"** — that is what makes #165 an entry plus a component rather than a rewrite.

### Task 6 — `ScatterCanvas.svelte`

**Deliverable:** the dumb renderer. Two layered canvases, LOD image cache, pan/zoom. Knows nothing about people. Props in §4.3.

**Tier 2 (Playwright)** only — it is canvas, and nothing else can see it. New `e2e/scatter.spec.js` driving a fixture-backed instance: drag a lasso, assert the caught count; zoom in, assert crops appear (via the network requests, not pixels); `trackPageErrors` empty.

### Task 7 — the view

**Deliverable:** `ui/src/lib/views/FaceMapView.svelte`, one descriptor in `ui/src/lib/views/registry.js`, one `viewProps` case and one `WORKING_SET_LOADERS` entry in `App.svelte`, one edit to the `V` row in `ui/src/lib/ShortcutsOverlay.svelte`. `offerable` per §7.1.

**Tier 1:** `views/registry.test.js` covers it without being edited (it iterates `VIEWS`) — add only the explicit "declares open/select/rate" assertion that the ALBUMS and PEOPLE blocks each have. **Tier 2:** `e2e/views.spec.js` also iterates; check the empty state is honest before it does.

### Task 8 — bulk merge and undo

**Deliverable:** `mergePersonsBulk(db, intoId, fromIds, { name })` and `server/db/personUndo.js`; `POST /api/ml/people/merge-bulk`, `POST /api/ml/people/undo-merge`. Detail in §5.

**Tier 1, heavily** — this is the destructive one, and `mergePersons` already has one shipped bug's worth of subtlety in it (the `person_source` marking of _both_ sides, `server/db/faces.js:697`). Assert: 500 sources merge in one transaction; `person_source` is restored **per face to its prior value** by undo, not blanket-set; a name conflict is refused, not silently resolved; a person deleted mid-flight is skipped and reported; the undo log caps at N and the oldest is dropped; `intoId ∈ fromIds` is filtered, not thrown on.

### Task 9 — the review tray

**Deliverable:** the tray inside `FaceMapView.svelte`: caught persons as crops with face counts, drop-any, name-conflict resolution, merge, undo affordance.

**Tier 2:** `e2e/face-map.spec.js` — lasso, drop one, merge, assert the person count fell by the right number, undo, assert it came back. Per `docs/TESTING.md`: click the button, do not merely assert it renders.

### Task 10 (optional, but the README asks for it) — the quality gate

Port `twin-rank-hard.mjs` into a doubly-gated vitest (`ML_INTEGRATION=1` + `AUTOGALLERY_PROJECTION_FIXTURES`), skipping **loudly**, exactly as `embeddingSimilarity.test.js` does and for the same reason: a silent skip on the only check that the coordinates mean anything is indistinguishable from a pass. The README says this "should become a permanent gate rather than a one-off"; it will not become one unless it is a task.

---

## 2. The `worker_threads` design

### 2.1 The invariant that keeps this simple

**The worker never touches SQLite, and imports nothing native.** The parent reads centroids, transfers a `Float32Array`, the worker returns coordinates, the parent writes. Consequences worth stating in the module doc:

- `better-sqlite3`'s ABI trap (`docs/AGENT-NOTES.md`: "a one-way switch") stays entirely out of the worker;
- there is nothing to `asarUnpack` and nothing to `electron-rebuild`;
- the worker's whole dependency surface is `umap-js`, which is pure JS.

### 2.2 The protocol

Parent → worker: `workerData` for the immutable inputs, transferring the buffer.

```js
new Worker(WORKER_URL, {
  workerData: { xy: /* ArrayBuffer, transferred */, n, dim, algorithm, params, seed },
  transferList: [buffer],
  resourceLimits: { maxOldGenerationSizeMb: 3072 },
});
```

Worker → parent, **a switch on `msg.type`, never an `if`** — that is the seam that lets `"embedding"` be added later without touching the handler's shape:

| frame                            | when                           | payload                           |
| -------------------------------- | ------------------------------ | --------------------------------- |
| `{type:"phase", phase, note}`    | entering kNN / entering epochs | a user-facing string              |
| `{type:"progress", done, total}` | every ~8 epochs                | epoch counts                      |
| `{type:"done", xy}`              | end                            | `Float32Array` (transferred back) |
| `{type:"embedding", epoch, xy}`  | **reserved, not built in v1**  | see §8                            |

**Transferables, honestly.** Transferring the 52.8 MB input buffer avoids a structured clone and keeps the parent's heap clean — worth doing. But do not oversell it: umap-js's `fit`/`initializeFit` take `number[][]`, so the worker must materialize _n_ JS arrays anyway, which is a large slice of the measured 1,825 MB peak. Build them once, drop the flat buffer immediately (`data = null`) so V8 can reclaim the 52.8 MB before the graph phase peaks.

**`resourceLimits` is the strongest argument for `worker_threads` and it is not in the stated rationale.** A projection that OOMs on the main thread is an app crash with no error anywhere. In a worker with an explicit `maxOldGenerationSizeMb`, it is an `ERR_WORKER_OUT_OF_MEMORY` `error` event the supervisor catches and turns into a specific, actionable job failure: _"This library is too large to map on this machine (25,758 people needs about 2 GB). Raise the minimum-faces filter to 2 and try again."_ That is a `CLAUDE.md`-compliant failure; a segfault is not. Put it in the design doc.

### 2.3 Progress — the two-phase plan is _nearly_ right, and §2 does not forbid it

`UI-CONTRACTS.md` §2 forbids "an indeterminate bar against a **known** total". During `initializeFit` the total is genuinely not knowable in work units: it is one opaque call with no callback. So an indeterminate phase 1 is not #208. But three things must be true or it reads as a hang anyway:

1. **Cancel must work during phase 1.** It does — `worker.terminate()` uses V8's `TerminateExecution` and interrupts a tight loop. A "Stop" that responds is the single biggest difference between "working" and "wedged".
2. **The phase string must name the work and move.** `phase` already exists on the job (`server/jobs/registry.js:48`, used by materialize). Set it to `"Building the neighbour graph — about 14 s, can't be interrupted mid-step"` and update it with elapsed seconds every second, from the **parent** (the worker is blocked and cannot post). A number that changes is proof of life.
3. **`total` must be set at `registry.create`, not on the first tick** — the #208 half that _does_ apply here.

That last one has a clean fix: **always pass `nEpochs` explicitly** as a run parameter rather than letting umap-js derive it from its own size heuristic (500/400/300/200 by point count). Then `total` is knowable before the worker starts, it is part of the cache key, and the run is more reproducible. Do this.

Then, with §0.1's `minFaces: 2` default, phase 1 is ~2 seconds and the whole argument is nearly moot for the default path.

**`setPrecomputedKNN` does not change the picture — verify this before believing otherwise.** It exists (`setPrecomputedKNN(knnIndices, knnDistances)`), and it would let you own the neighbour search and therefore report proportional progress. But you would be re-doing what DruidJS did wrong: exact kNN in 512-d is a linear scan. The repo's own measured rate is 2.7M int8 pairs/sec (`server/ml/faceClusters.js:106`); at 25,758 points the upper triangle is 332M pairs ≈ **123 seconds** versus umap-js's approximate 14.1 s. Buying honest progress at 9× the wall clock is a bad trade. Record this as evaluated and rejected so it is not re-proposed.

Note also: epochs are _uniform_ work, unlike `clusterFaces`' upper triangle, so an epoch-index bar is honest — the "progress is measured in WORK, not items" warning does not bite here. Say so, or someone will "fix" it.

### 2.4 Cancellation and error propagation

- The job's `AbortController` (`registry.create` gives you one) is the trigger; `signal.addEventListener("abort", () => worker.terminate())`.
- `terminate()` resolves the worker's `exit` with code `1`. **Treat `error` and `exit` as racing events settling one promise, idempotently, keyed on worker identity** — verbatim the `#killChild` pattern at `server/ml/OnnxMLService.js:169`, which exists because a double-settle there took the whole server down.
- Unlike the stdio protocol ("THE ERRNO DIES HERE", `server/ml/OnnxMLService.js:214`), `worker.on("error")` delivers a real Error with a real stack via structured clone. Do not rely on custom properties surviving; tag on the parent side.
- Always `terminate()` in a `finally`, and never `unref()` — an unref'd worker still runs and still allocates 750 MB, it just stops holding the process open, which is exactly the wrong tradeoff.
- A cancellation is an outcome: `registry.fail(job.id, e)` already reads the abort signal and records `"canceled"`. Use it; do not branch by hand.

---

## 3. Packaging risk

### 3.1 What is actually different from #203

`docs/AGENT-NOTES.md` records that the ML worker spawns fine from a packaged build. **That verification does not transfer**, and the difference is not cosmetic:

|               | ML worker (#203, verified)                      | Projection worker (unverified)                                       |
| ------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| mechanism     | `child_process.spawn(process.execPath, …)`      | `new Worker(url)` in-process                                         |
| environment   | `ELECTRON_RUN_AS_NODE=1` — a plain Node process | a Node worker thread **inside the Electron main process**            |
| asar handling | Electron's Node-mode asar support, proven       | Electron's main-process asar patching, **in a fresh worker isolate** |

In a packaged build the Express server runs inside Electron's main process (`docs/AGENT-NOTES.md`: "Only a PACKAGED build runs the server inside Electron"), so `new Worker()` creates a Node worker thread inside Electron. Whether Electron's `fs` asar interception is installed in that isolate's module loader — such that an **ESM** entry at `/…/app.asar/server/projection/worker.js` resolves and its relative and bare imports resolve — is the open question. This is the exact shape of #67 and #203: holds in dev (plain directories, plain Node), fails only in the artifact.

### 3.2 What must be verified, in order

1. **A worker thread can start at all inside Electron 43's main process.** Node worker threads in Electron have historically had caveats.
2. **An ESM worker entry resolves from inside `app.asar`.**
3. **Its relative imports (`./umapAdapter.js`) and its bare import (`umap-js`) resolve from inside `app.asar`.**
4. **`resourceLimits` is honoured** — Electron's Node integration is not always identical here, and an unhonoured limit turns a caught OOM into a crash.

### 3.3 The mitigation, and when to apply it

If any of 1–3 fails, the fix is one line: add `"server/projection/**"` to `build.asarUnpack` in `package.json`. Then the worker is a real file on a real filesystem and asar is not involved.

**Do not add it pre-emptively.** #203's own conclusion is that the pre-emptive `asarUnpack` entry it proposed "would have been dead weight". Verify, then add only if needed — and record the verification either way.

### 3.4 What test pins it

Extend `server/ml/asarPackaging.test.js` (rename its describe, or add a sibling `server/projection/asarWorker.test.js` following the identical two-tier shape):

**Tier A — config assertions, always run, no binary needed.**

- `build.files` contains `server/**/*` (already asserted; the projection worker rides on it);
- if §3.3's mitigation was applied, `asarUnpack` contains `server/projection/**` — so removing it is a red test, not a silent regression;
- `umap-js` is in `dependencies`, not `devDependencies` (a devDependency is not in the packaged tree at all, and the failure would be a runtime `ERR_MODULE_NOT_FOUND` inside a job).

**Tier B — a live probe, skipping LOUDLY when the Electron binary is absent.** Extend the existing miniature-asar probe: the packed ESM entry additionally does `new Worker(new URL("./child.js", import.meta.url))` and reports what the child resolved. This proves links 2 and 3 under Electron's Node.

**State the residual honestly in the test's doc comment:** `ELECTRON_RUN_AS_NODE` is not byte-identical to Electron's main process, so Tier B narrows the risk but does not close it. The gold standard is #203's own: **one manual run against a real `electron:build:mac` artifact**, with the result and date recorded in `docs/AGENT-NOTES.md` under "Dependency landmines" next to the ML-worker entry. Gate the release that ships this feature on that run.

---

## 4. The shared scatter seam

### 4.1 What is pure

`ui/src/lib/scatter/` — the `albumTimeline.js` precedent exactly: "the component draws things; everything here answers questions".

| module         | exports                                                                               | why pure                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `transform.js` | `toScreen(x,y,t)`, `toData(px,py,t)`, `fitExtent(xs,ys,w,h,pad)`, `clampZoom`         | the one place screen↔data is defined, so hover, lasso and draw cannot disagree — the bug `hitAt` exists to prevent |
| `hit.js`       | `buildIndex(xs,ys)` → d3-quadtree; `nearest(index,x,y,r)`                             | d3 is already a dependency and `quadtree.visit` prunes by rect for free                                            |
| `lasso.js`     | `pointInPolygon(x,y,poly)`, `polygonBBox`, `simplify(path,eps)`, `caught(index,poly)` | ray casting is the classic off-by-one; test it, do not eyeball it                                                  |
| `lod.js`       | `imageSide(k)`, `shouldDrawImages(k)`, `imageBudget(visibleCount)`                    | one rule for "which crops to request" and "what to draw" — two rules drift                                         |

### 4.2 25,758 face crops without 25,758 `<img>` elements

Four mechanisms, all in `ScatterCanvas.svelte`:

1. **LOD by construction.** Crops are drawn only when a point occupies ≥ ~24 CSS px, which at any sane zoom means **~100–400 points are on screen**. There is never a moment when thousands of images are wanted. `shouldDrawImages(k)` is the single predicate.
2. **An LRU cache of `HTMLImageElement`, capped at ~600**, plus an in-flight `Set`. Request only for viewport points, nearest-to-centre first. The browser caps concurrency at 6 per origin over HTTP/1.1 for free, which is the right number given the server cost below.
3. **Always draw a coloured dot underneath.** An unloaded crop is a dot, never a hole. `img.complete && img.naturalWidth > 0` before `drawImage`.
4. **Request `size=160` — the same size `PeopleView.svelte:164` uses.** The crop cache is keyed `(photo, faceId, px)`, so picking a different size generates a second full generation of cached JPEGs on disk. Reusing People's warm cache is free and halves the disk cost. Note the server-side cost this avoids: `/api/ml/faces/:id/crop` does a full `sharp` decode of the **original** on a miss (`server/api.js:1972`).

**Two canvases, not one.** A `points` layer redrawn on transform/data change, and an `overlay` layer for the lasso path, hover ring and caught-set highlight redrawn per pointer frame. `AlbumTimeline.svelte:120` claims 20,000 `arc()` calls in "about a millisecond", which is optimistic; at 60 fps during a lasso drag you would find out. Also prefer `fillRect` over `arc` for sub-3px dots — several times cheaper and visually identical at that size.

### 4.3 The prop contract that makes #165 an entry plus a component

```js
<ScatterCanvas
  points={{ x: Float32Array, y: Float32Array, ids: Int32Array,
            size: Float32Array|null, group: Uint8Array|null }}
  {width} {height}
  imageFor={(i) => string|null}    // url for point i; null = dot only
  labelFor={(i) => string}         // tooltip text
  highlighted={Set<number>}        // INDICES, drawn ringed
  onlasso={(indices, mods) => {}}  // mods: {shift, meta}
  onhover={(index) => {}}          // -1 for nothing, like hitAt's convention
  onpick={(index, event) => {}}
  bind:transform                   // {k, tx, ty} — parent owns reset / zoom-to-fit
/>
```

Two rules make this a real seam rather than a hopeful one:

- **Every callback speaks INDICES, never ids.** The component never learns what a point means. `ids` rides along only so the parent can map back.
- **Parallel typed arrays, never an array of objects.** #165's 64,026 photo points would otherwise be 64,026 JS objects, and this also lets the server ship x/y as a binary payload later with no component change.

#165 then supplies `imageFor = (i) => thumbUrl(ids[i])` and its own view descriptor. That is the whole diff. **Enforce it with the structural test in Task 5** — an import of `api.js` or the word "person" inside `scatter/` is the first crack.

---

## 5. The bulk merge

### 5.1 Do not loop `mergePersons` — write `mergePersonsBulk`

Calling `mergePersons(db, into, from)` N-1 times inside one transaction breaks in four ways:

1. **`UPDATE photo_faces SET person_source='manual' WHERE person_id = into` runs N-1 times** (`server/db/faces.js:703`), each over the target's _growing_ face set. A lasso of 500 persons onto a 3,512-face target is on the order of a million redundant row updates in one transaction.
2. **The name chains unpredictably.** `into.name || from.name` applied iteratively means the surviving name depends on loop order. See §5.3.
3. **`cover_face_id` is never revisited**, so the merged person keeps the target's cover even when a merged-in group has a far better face. Use `saveClusters`' own `bestOf` rule (`server/db/faces.js:413`): highest `det_score` across the merged set.
4. **One bad row aborts everything.** A person deleted between lasso and submit throws `no such person` and rolls back 499 good merges.

`mergePersonsBulk(db, intoId, fromIds, { name })` instead: one `UPDATE photo_faces … WHERE person_id IN (…)`, one mark on the target, one `DELETE FROM persons WHERE id IN (…)`, one cover recompute — inside one transaction, in that order. Filter `intoId` out of `fromIds` first. Return `{ id, moved, name, mergedCount, missing: number[] }` so the caller can say _"merged 497; 3 were already gone"_ rather than failing.

### 5.2 Refuse while a regroup is in flight

`saveClusters` clears model-owned assignments wholesale. The bulk merge marks everything `'manual'`, so it survives — but a merge landing mid-regroup produces a partition computed from a stale read. Mirror the cluster route's own 409 (`server/api.js:1901`), with the same wording shape.

### 5.3 Two differently-named persons in the lasso

This is the case that must **not** be resolved silently. `mergePersons`' current rule ("if both do, `into` wins, because that is the row the user pointed AT") is correct for a two-person merge where the user pointed at one row. In a lasso there is no row the user pointed at, and losing a name is invisible data loss the user finds out about weeks later.

**Contract:** if the caught set contains ≥ 2 **distinct non-empty** names, the tray refuses to merge until the user picks. Show the candidate names as radio options plus "type a new one", and pass the chosen `name` explicitly to `mergePersonsBulk` — which then never applies the `||` heuristic at all. With exactly one name present, pre-select it (no friction in the common case). With none, the field is the naming input the workflow already wants.

This is `CLAUDE.md`'s "confirm or make-undoable anything destructive" and "prefer specific over generic", and it is cheap: the tray already has every name it needs on screen.

### 5.4 The undo record — shape, cap, and the field everyone forgets

```sql
CREATE TABLE IF NOT EXISTS person_merge_undo (
  token            TEXT PRIMARY KEY,   -- opaque, returned to the client
  created_at       INTEGER NOT NULL,
  into_id          INTEGER NOT NULL,
  into_name_before TEXT,               -- an inherited name must be reversible
  payload          BLOB NOT NULL       -- see below
);
```

`payload` is JSON (in a BLOB column, so it can become a typed-array encoding later with no migration):

```jsonc
[
  {
    "personId": 8123,
    "name": null,
    "coverFaceId": 55012,
    "createdAt": 176,
    "faces": [
      [41201, "model"],
      [41288, "manual"],
    ],
  },
]
```

**The field everyone forgets is the per-face `person_source`.** The merge sets every moved face — and every one of the target's own faces — to `'manual'`. An undo that blanket-restores `person_id` but leaves `person_source = 'manual'` silently freezes those faces as human decisions, and the next grouping pass can never revise them. Record the prior value per face, both for the sources **and for the target's own faces**, and restore it.

**Cap in two places, because they fail differently:**

- **Row count:** keep the last **10** merges; delete older ones inside the same transaction that inserts a new one. A count-based bound, not a clock-based one — same reasoning as `RECENT_MAX` at `server/jobs/registry.js:19`.
- **Payload size:** a lasso of 500 persons totalling ~100k faces is ~1 MB of JSON. Fine for SQLite; and it **never crosses the wire**, which is the whole point of decision 9 versus the client-held manifest whose 413 is quoted in `undoFailureMessage` (`ui/src/lib/jobs.js:76`). Still, refuse a merge whose face count exceeds a stated cap (say 250,000) with a specific message rather than writing an undo record you cannot honour.

**Decision 9 is right, and for a second reason nobody stated:** an undo the _server_ holds survives a page reload, which the client-held manifest never did. Say so in the module doc.

**Not a job.** ~100k row updates in one SQLite transaction is well under a second. `POST /api/ml/people/undo-merge` returns synchronously with counts. The existing `undo-move` is a job only because it does filesystem work.

### 5.5 Why decision 6's INNER JOIN works, and why the FK must NOT cascade

Serving points via `INNER JOIN persons` makes merged-away persons vanish with no re-projection — correct, and the neatest part of this design. But do **not** add `REFERENCES persons(id) ON DELETE CASCADE` to `projection_point.ref_id`: the point rows must survive the merge so that an **undo brings the dot back**. The INNER JOIN already hides them. Add a `pruneRuns` sweep for genuinely orphaned points at run-creation time instead, and write the reason in the schema comment — otherwise the next reader will "fix" the missing cascade.

One more schema note: `projection_runs.params` as JSON is fine for storage but the **cache key must be a canonicalised string**, not the raw JSON — `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same run and would otherwise be two. Sort keys before hashing, and cover it with a test.

---

## 6. Contract conformance

### 6.1 Contract 1 — scope. **Decision 7 is defensible; the exemption claim is not.**

"No All/Visible/Selected because a UMAP of a subset is not a subset of the UMAP" is a correct statement about the maths and a **non-answer to the contract**. The contract's requirement is _"every operation over photos states its scope, and the user picks it"_, with a live count and a cost estimate that tracks the choice. It does not mandate three radio buttons; it mandates that the user is never offered a single button that means "spend twenty minutes on everything".

So the honest conformance position is: **this operation has exactly one scope dimension, `minFaces`, and it is a run parameter** (§0.3). Satisfy the contract by:

- rendering the min-faces choice with a **live count** — "≥2 faces · 5,499 people" / "everyone · 25,758 people";
- an estimate that **tracks the choice**, via the existing `formatEstimate(n, msPerPoint)` (`ui/src/lib/scopeControl.js:86`) rather than a second copy of the arithmetic;
- **refusing an empty scope specifically** — `minFaces: 40` leaving 3 people is "3 people is not a map", not a job that starts and finishes in 40 ms;
- **not** wiring `ScopeControl.svelte`. Its `name`-uniqueness and `scopeIdsFor(null vs [])` machinery is about photo-id lists, and this is not one. Forcing it in would be the worse violation.

A second, easily-missed instance: **the merge itself is an operation over photos** (it rewrites `photo_faces`). Its scope is the review tray — a live-counted, user-editable set with drop. That _is_ contract 1, in a different shape. Say so in `FaceMapView.svelte`'s doc comment so a reviewer does not read its absence as an omission.

**What would violate the contract:** a bare "Build map" button quoting no count and no time. That is precisely #221's `[ Find faces in 32,000 photos ]` wearing different words.

### 6.2 Contract 2 — locus of control

| requirement                                  | status                                                                                                                                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| visible in JobsPanel from the main interface | ✅ registry job                                                                                                                                                                                                                                                       |
| honest progress                              | ⚠️ see §2.3 — needs `nEpochs` as an explicit param so `total` is set at `registry.create`, and a moving phase string during kNN                                                                                                                                       |
| genuinely cancellable                        | ✅ `terminate()`, and it interrupts the unyieldable phase, which is more than `clusterFaces` can do                                                                                                                                                                   |
| `summarize()` branch                         | ❗ **required**, not optional. A `"projection"` job with no branch in `ui/src/lib/JobsPanel.svelte:147` renders a bare ✓. Write it: _"5,499 people · UMAP · 4.2 s"_.                                                                                                  |
| cancellation is an outcome                   | ✅ `registry.fail` reads the abort signal                                                                                                                                                                                                                             |
| refusals before `registry.create`            | ❗ enforce: model missing, `isClusterInFlight()`, `isProjectionInFlight()`, and **cache hit** are all synchronous answers before any job exists                                                                                                                       |
| single-flight latch                          | ❗ needed. Two runs with identical params would both compute and both write the same `run_id`. Copy `withClusterLatch` (`server/ml/faceClusters.js:140`) including its `finally` — "leaving it set makes every later run a silent no-op for the life of the process". |

One addition the contract implies but the design does not state: **a cache hit must start no job at all.** `{reused: runId}` with the points fetched directly is the "if the pending count is zero, say so and start no job" rule applied to a different quantity.

### 6.3 Contract 3 — placement. **Decision 8 is half right.**

Placement itself is correct: a map of your people is a view, not a panel. The per-view configuration gear is fine — it is the view's own controls, the shape `AlbumsView` already has with its k-slider and setup modal. What would violate §3 is putting the map inside gear → Machine learning; do not.

Two problems with decision 8's capability declaration:

**`open: false` is probably wrong.** The tray shows face crops. If clicking one shows you that face's photo — which the workflow plainly wants, since you cannot judge a merge from a 160px crop — then the view _does_ open photos, App has `openPhotoById`, and `ALBUMS` sets `open: true` for exactly this. Declaring `false` while wiring an `onopenphoto` prop is a lie that nothing currently catches, because the registry's own doc admits `capabilities.open` is "declared but not yet read by anything". The moment something reads it, the feature breaks. **Pick one:** offer photo-opening and declare `open: true`, or do not offer it and declare `false`. Do not do both.

`select: false` and `rate: false` are right, and for PeopleView's exact reason: `selected` indexes a feed window this view does not render.

**The real gap is view-local keys, and this feature is the first to hit it.** `UI-CONTRACTS.md` §3's own table says "View-specific keys, declared" belongs in the view — but the registry has **no field for them**, and `App.svelte`'s `onKeydown` owns the window. Concretely, this view wants `Escape` (clear the lasso), `⌘A` (catch everything visible), `Delete` (drop from the tray), and today:

- `X` hits `refuseUnsupported("select", "Selecting photos")` (`ui/src/App.svelte:5882`) and tells the user _"Selecting photos isn't available in Face Map"_ — while the view has a perfectly good selection of people. That message is actively wrong.
- `⌘A` hits `refuseUnsupported("select", …)` at `App.svelte:5660`.

Two options, and I would take the second:

1. Do nothing and accept the wrong messages. Cheap, but it is the "silently swallowing the keystroke" failure with a misleading label bolted on — worse than silence.
2. **Add one declarative field to the registry**: `keys: [{ keys: ["Escape"], label: "Clear the lasso" }, …]`, consumed by `ShortcutsOverlay.svelte` (so the "a shortcut nobody can find does not exist" rule holds automatically) and checked by `refuseUnsupported` before it refuses. This is a ~20-line change to the registry and it is the fourth view paying #155's promised dividend rather than re-deriving the boundary. Do it **first and alone**, as its own commit, per §3's "do the registry first" rule.

---

## 7. Traps this will trip over that are not on your list

### 7.1 The toolbar folds by width, and this is the **fourth** view

`docs/AGENT-NOTES.md` is explicit and this has now bitten twice (`PersonFilter.svelte`, then #223 at 1280px, **CI-only, with 151/151 green locally**). A fourth always-on switcher button will do it again.

Use `offerable` (`views/registry.js:164` is the precedent). The right predicate is not `peopleCount > 0` — a map of 3 people is useless. Something like `({ peopleCount }) => peopleCount >= 100`, or better, gate on whether a projection run exists for the current model. `V` still cycles to it either way, and its empty state explains how to fill it.

And: **a green local `npm run test:e2e` does not clear this.** Check CI's `e2e/toolbar-fold.spec.js` at 1280px specifically.

### 7.2 `navigation: "zoom"` inside a scrolling column is unimplemented territory

`.main-column` is `overflow-y: auto` (`App.svelte:6679`) with `onscroll={scheduleVisibleRangeUpdate}` and `onwheel={releaseJumpPins}`. Both existing non-grid views are `navigation: "scroll"`. This is the first `"zoom"` view, and `navigation` is a forward-declaration nothing reads.

Concretely: the view must fill the column (`height: 100%`), set `overflow: hidden` on itself, and `preventDefault()` on wheel so the column does not scroll while you zoom. Verify `releaseJumpPins` firing on every wheel event is harmless here (it probably is, but it is a per-wheel-event handler on a gesture that now fires continuously). Budget this as a real task, not a CSS afterthought.

### 7.3 `ResizeObserver` — do not re-lay-out inside the callback

This view needs one to size the canvas. `CLAUDE.md`'s third trap: it raises "ResizeObserver loop completed with undelivered notifications", an uncaught error that (correctly) fails `trackPageErrors`. Defer a frame with `requestAnimationFrame`, as `ToolbarRow.svelte` does.

### 7.4 Svelte 5 `$effect` self-write loop — the exact shape this view has

`AlbumTimeline.svelte:80` documents it: an `$effect` that both reads and writes the same `$state` re-fires on its own write, because each assignment re-proxies to a fresh reference — `effect_update_depth_exceeded`, tab locked. The scatter's `transform` (`{k, tx, ty}`) is precisely that shape: pan/zoom writes it, and a redraw effect reads it. Drive the redraw imperatively from the pointer handler, or `untrack` the write. Also: the component is **all-runes** (new file, and `PeopleView.svelte` is runes) — never half.

### 7.5 The `items` boundary, with the twist this feature adds

The view must never touch `items`. `dataSource: "working-set"` plus a `WORKING_SET_LOADERS` entry covers entry. **The twist:** the user can start a _new_ run and needs new points, mid-session — which is not "entry". Do not let the view fetch its own points; that is how the boundary rots. The view emits `onrun(params)`, App starts the job, awaits it (`waitForJob`, `ui/src/lib/jobs.js:117`), fetches the points, and passes them down. Same shape as `PeopleView`'s `onmore` → `refreshPeople`.

### 7.6 `restorableViewId` means the map does not survive a reload

A working-set view is not restored (`views/registry.js:223`), so a user who built a map and reloaded lands on the grid. That is the existing rule and it is right — but the run **is** cached server-side, so re-entering is instant. Say so in the empty state, or the user will conclude the map was lost.

### 7.7 The 59% the map cannot show

69,786 faces (59%) belong to no person, so they are not on the map at all. The README says this "matters here only because it caps what any map can show, **and the view has to say so**." That is a usability-contract obligation, not a nicety. One line in the view header, with the action attached: _"48,585 of 118,371 faces are grouped — the rest have never been through a grouping pass. [Group faces]"_. Without it, a user lassoing the whole map and merging reasonably concludes they are done.

### 7.8 Smaller ones, each cheap and each a shipped-bug shape

- **`buffalo_s` vs `buffalo_l`.** Runs are per-model. Include `model` in the cache key (decision 6 does) _and_ say which model's map is on screen, or a pack switch shows a stale map with nothing explaining it.
- **`queryPlan.test.js`.** New table, new access path. The repo's own rule: index-dependent plans rot silently.
- **Zero-width canvas.** `AlbumTimeline` guards `width > 0`; a `canvas.width = 0` throw would fail `trackPageErrors`. Guard it.
- **Destructive-test isolation.** The merge deletes `persons` rows. Vitest tests need temp DBs; e2e needs a `resetPeople` helper next to `resetRatings` in `e2e/helpers.js`, and `AUTOGALLERY_HOME` already points at `e2e/.tmp/home`.
- **`node -e "import('./server/projection/runProjection.js')"`** after moving any function between server modules — the vitest-vs-node trap that cost a cycle in #221. (Task 2's test spawns real Node, so the worker itself is covered; the parent module is not.)
- **Version + CHANGELOG in the same commit**, `claim-version.sh` for the number, branch off `origin/testing`, PR `--base testing`.
- **`ShortcutsOverlay.svelte:84`** — the `V` label enumerates the views ("grid → Auto Albums → People → grid"). A fourth view means editing that string, in the same commit.
- **`e2e/views.spec.js` iterates `VIEWS`** — a new view is covered for free and can therefore _fail_ for free, before you have written a spec for it. Check its empty state before adding the descriptor.

---

## 8. What I would cut

Ruthlessly, in descending order of what it saves.

**1. The algorithm menu. Ship UMAP only.** This is the big one, and it contradicts a stated user wish, so here is the argument rather than the verdict: of the five algorithms measured, PCA (2.8%) and MDS (2.8%) score at chance on the real task, and SQDMDS (0.0%, median rank 1822) is documented in this folder as _the trap_ — perfect on the easy test, worst on the real one. A dropdown whose options include three known-bad choices is a footgun with a UI, and the one genuinely good alternative (t-SNE, 62.5%) is only affordable _after_ the user has learned the min-faces filter. So: keep `projection_runs.algorithm` in the schema (the seam is real and costs one column), ship one value, and add t-SNE when the member count is under ~6,000 — where it can be offered as _"slower and better"_ rather than as _"this will wedge for 47 minutes"_. That also removes `@keckelt/tsne` and `ml-pca` and their licence verification from v1 entirely.

What the user actually wants — control — is better served by shipping the **parameter** gear now (`minFaces`, `nNeighbors`, `minDist`, `nEpochs`, seed), which is cheap, useful, and the part that changes the map most.

**2. Progressive/streaming layout.** Watching the map form is genuinely delightful and it is a whole second data channel (per-epoch coordinates, outside the job registry). Reserve `{type:"embedding"}` in the protocol, make the message handler a `switch`, build nothing. With `minFaces: 2` the whole run is ~4 s, and there is nothing to stream.

**3. JL 512→64 dimensionality reduction.** The README already concluded this (20.5 s → 13.2 s, "not worth the code or the unvalidated fidelity question"). Agree, and `minFaces: 2` makes it moot.

**4. A run browser / multiple named runs.** Keep the last 3 runs per `(kind, model)` and prune. No UI to list them. Params in, map out; the cache is an implementation detail the user should never have to think about.

**5. An atomic merge-and-name endpoint.** `mergePersonsBulk` then `renamePerson` — two operations that already exist and are already tested. One button in the UI calling two endpoints is fine; a third endpoint that does both introduces a new partial-failure state (merged but unnamed) for no gain. _(Do keep the name **conflict resolution** from §5.3 — that is a precondition of the merge, not a second operation.)_

**6. Per-item undo inside the tray.** Drop-any is enough; re-lasso is the undo. One undo, at the merge, server-side.

**7. `navigation: "zoom"` becoming a real contract.** It is a forward-declaration today. Implement this view's zoom concretely (§7.2); do not generalise the registry's viewport ownership until a second zoom view exists.

**8. #165's photo scatter.** Explicitly out — which everyone agrees on. The point worth making is that the seam costs nearly nothing _if and only if_ `ScatterCanvas` never learns what a point means, and that is enforced by a test (Task 5), not by intent.

**Keep:** dots sized by face count (one `Float32Array`), and dots coloured by named/unnamed (one `Uint8Array`). With 6 named out of 25,758, "which of these have I already done" is real information for about eight lines of code.

---

## 9. Summary of required changes to the stated decisions

| #   | decision                                                                 | verdict                                                                                                                                    |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | dot = person centroid                                                    | ✅ right. Note the centroid means less for the giants — but the giants are not merge candidates either.                                    |
| 2   | faces now, #165 later, design the seam                                   | ✅ right. §4.3 is the seam; enforce it with a test.                                                                                        |
| 3   | `worker_threads`, not main, not the ONNX child                           | ✅ right, and stronger than argued — `resourceLimits` turns an OOM crash into a catchable job failure (§2.2).                              |
| 4   | umap-js only                                                             | ✅ right library, ❗ **wrong licence** — Apache-2.0, not MIT (§0.2).                                                                       |
| 5   | algorithm + params in a per-view gear, runs cached                       | ⚠️ params yes; **algorithm menu cut from v1** (§8.1).                                                                                      |
| 6   | `projection_runs` + `projection_point WITHOUT ROWID`, INNER JOIN persons | ✅ right. Add: no cascading FK on `ref_id`, or undo cannot bring a dot back (§5.5); canonicalise the params JSON before using it as a key. |
| 7   | no All/Visible/Selected; a min-faces filter instead                      | ⚠️ right to skip `ScopeControl`; **wrong that it is client-side** (§0.3), and the exemption still owes a live count + estimate (§6.1).     |
| 8   | all capabilities false                                                   | ⚠️ `select`/`rate` right; **`open` probably wrong** (§6.3); and the missing piece is view-local key declaration.                           |
| 9   | server-side undo with a token                                            | ✅ right, and for a second reason: it survives a reload. Add per-face `person_source` to the record (§5.4).                                |

Sources for the licence finding: [PAIR-code/umap-js LICENSE](https://raw.githubusercontent.com/PAIR-code/umap-js/main/LICENSE), [src/umap.ts header](https://raw.githubusercontent.com/PAIR-code/umap-js/main/src/umap.ts), [package.json](https://raw.githubusercontent.com/PAIR-code/umap-js/main/package.json), [npm umap-js](https://www.npmjs.com/package/umap-js), [@keckelt/tsne](https://github.com/keckelt/tsne).
