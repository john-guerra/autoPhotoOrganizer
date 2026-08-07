# The Face Map's neighbourhood, and the map it actually shows you

Design for **#325** (a stale cached map is served forever) and **#326** (the
`nNeighbors` default, and why it must not be computed).

The two ship together because they are the same complaint wearing two faces:
_the map I am looking at is not the map I asked for._ One is a wrong number in
a schema; the other is a right number pointing at the wrong data.

The third piece that came out of the same session — a live settings panel —
is **#327**, and it gets its own spec. See "What this deliberately does not
do" at the end.

---

## The measurement that started it

John reported that at a neighbourhood of 50 the map showed "only a handful of
faces regardless of there being 200+", and that any other value fixed it. Two
separate things turned out to be true, and only one of them was the bug.

### UMAP at 50 is fine

Running the real worker over his real person-centroids at `nNeighbors` ∈
{15, 46, 49, 50, 51, 60} gives a healthy, well-spread layout at every value; 50
produced the **most** distinct positions of the six (203 of 216). There is
nothing wrong with the number 50 as a projection parameter. #307 did not break
anything.

(That run saw **216** members at `minFaces: 2`; the sweep an hour later saw
**255**, because face grouping was still running. The member set moving under a
cache keyed only on parameters is the #325 mechanism, observed live during its
own investigation.)

### The map was stale, and 50 was simply the default

`findRun` (`server/db/projections.js:52`) keys a run on
`(kind, model, algorithm, sha1(params))` — the **parameters**, not the
**inputs**. The run's real input is the member set, which is invisible to the
key. So a run built when face grouping was half done is served forever.

`POST /api/projections` computes today's member count at `server/api.js:2508`
and then ignores it at 2528: a cache hit returns
`{reused: true, members: cached.members}` — the count from when it was built —
and starts no job.

Two aggravating factors turn that into "50 is broken":

- **The default parameters are the stalest run you own.** `App.svelte:2735`
  holds `mapParams = { algorithm: "umap" }`, so entering the view fetches
  `/current?algorithm=umap` and the server fills in its own defaults. The
  default run is therefore the one you built _first_ — when the fewest people
  had been clustered — and it is the one the app shows on every fresh session.
  Any other value you type mints a new cache key and gets built fresh, which
  makes the default look uniquely broken. **50 was a proxy for "the defaults",
  not a property of 50.**
- **The evidence deletes itself.** `pruneRuns(keep: 3)` (`api.js:2576`) evicts
  older runs, so three parameter experiments delete the offending run and the
  symptom vanishes. By the time John's index was inspected, only three healthy
  216-point runs at 17/46/51 remained. He could not reproduce it, and that is
  expected rather than reassuring.

`runStaleness` already reports the drift and `FaceMapView.svelte:321` already
renders it — _"N added since — rebuild to place them"_. It is a caption beside
a near-empty map. It reads as "broken", not as "press this".

---

## The neighbourhood cannot be computed, and this is the evidence

The other half of the session was a proposal: make `nNeighbors` adapt to the
library instead of being a fixed 50. #307's own note argued for it —
_"worth knowing it is a RATIO he validated… a default derived from the point
count would preserve what he actually saw."_

It was tested and it does not work. **This section exists so nobody re-derives
it.**

### Method

40 real UMAP runs over the real person-centroids in John's index — same seed
(1212), same `minDist` (0.1), same 200 epochs, only `nNeighbors` varying across
{5, 11, 15, 22, 30, 36, 50, 75} — rendered as small multiples with real face
crops across five photo scopes. John picked the best cell in each scope.

The repo's own quality metric (`projectionQuality.test.js`: split a person into
two sessions, measure whether the map puts the halves together) **could not
arbitrate**: it found exactly **1 split pair** on this library, because it is a
handful of consecutive shooting days and almost nobody appears in two separate
sessions. Human judgement was the only instrument available. Recorded here so
the next person does not spend the afternoon rediscovering it.

### Result

| scope         | people (≥2 faces in scope) | pick   | people ÷ pick |
| ------------- | -------------------------- | ------ | ------------- |
| Whole library | 255                        | **30** | 8.5           |
| Austria 2     | 42                         | **15** | 2.8           |
| Austria 4     | 53                         | **36** | 1.5           |
| Austria 5     | 151                        | **22** | 6.9           |

Austria 1 is excluded: 634 photos but only 153 faces and 10 people with 2+
faces, so `worker.js` clamps `nNeighbors` to `n − 1` and all eight cells are
the identical run.

**Austria 2 (42 people) and Austria 4 (53 people) are nearly the same size and
the picks are 2.4× apart.** Any formula `f(members)` must return the same
answer for 42 and 53. That is a contradiction, not a poor fit.

Fitting a power law anyway:

```
k = 12.4 × members^0.149        R²(log) = 0.11
                    ^^^^^
     linear would be 1.000 · sqrt 0.500 · constant 0.000
```

Member counts span 6.1× across the scopes; the picks span 2.4×. The picks are
closer to constant than to proportional.

### Clustering does not rescue it either

The natural next move — estimate the number of real identities with a cheap
second pass and use that — was measured too (4–26 ms per scope, full pairwise
cosine over person centroids):

| scope     | components @0.5 | non-singleton | mean cluster size | pick   |
| --------- | --------------- | ------------- | ----------------- | ------ |
| Austria 2 | 9               | 6             | 4.7               | **15** |
| Austria 4 | 15              | 8             | 3.5               | **36** |

Near-identical structure, picks 2.4× apart. Correlations with the picks (n=4):
members `r=0.22`, components `r=0.26`, non-singletons `r=0.22`,
mean cluster size `r=−0.78` (wrong sign for any story, and not significant at
n=4).

The second-pass clustering is still worth having — as **merge suggestions**,
which is #329. It is not a way to tune this parameter.

### The honest caveat

n=4 picks from 8 discrete options with gaps (15 → 22 → 30 → 36). "Constant
≈ 25–30" is a **weak positive** claim. The strong claim is the negative one:
**size does not predict it.** The practical consequence is #327 — if the right
value is content-dependent and unguessable, the fix is a control that finds it
in seconds, not a cleverer default.

---

## What we build

### 1 · The default, and its comment (#326)

`server/projection/algorithms.js` — `nNeighbors` default **50 → 30**. 30 is
John's pick for the whole-library case, which is the case the default actually
serves.

The comment is the real deliverable. It currently tells #307's ratio story;
it must instead carry the numbers above and say plainly: **do not derive this
from the member count — it was measured, and it does not work.**

Test churn, already checked:

- `server/projection/algorithms.test.js:226` pins `toBe(50)` — update the
  number and the comment.
- The sibling test asserting the 58.3% figure is attributed to
  `nNeighbors=15` **stays**. It is what keeps a measured number from drifting
  onto a configuration it was never measured at.
- `e2e/face-map.spec.js:174` needs **no** change. It deliberately compares the
  gear to the server rather than to a literal — which is exactly why it
  survives a default change, and worth not "fixing".

### 2 · A cache hit must still describe the library (#325)

- **`POST /api/projections` honours a cache hit only when `cached.members`
  equals the member count just computed at line 2508.** Otherwise it is a miss
  and rebuilds. POST is an explicit user action; handing back a map of a
  library that no longer exists is the defect.
- **`GET /api/projections/current` is unchanged.** A read must not start a job.
  It keeps serving the cached run and keeps reporting `staleness`.
- **`FaceMapView.svelte:321` becomes a button**, not a caption — pressing it
  calls the existing `onrun`, so the rebuild is the same job, in the JobsPanel,
  cancellable. Contract 2 is untouched.

Why not put a member fingerprint in the cache key: it is the tempting fix and
it is worse. A background face sweep would then silently invalidate every map
the user owns, and each one costs 4–20 s to rebuild. Comparing the count at the
one moment the user has asked for a map gets the same correctness for none of
the cost.

### 3 · Tests, at the tier that would have caught it

- **`#325`** — a vitest test that creates a run, adds a person, POSTs again,
  and asserts the response is **not** `reused: true`. Revert the fix and
  confirm it goes red before committing; a test that never failed proves
  nothing.
- **`#326`** — the existing default assertion, updated.

---

## What this deliberately does not do

- **No adaptive `nNeighbors`.** Measured, refuted, recorded above. Building it
  would be a clustering pass, a cache key that depends on library state, and a
  number the user cannot predict — bought with an R² of 0.11.
- **No live settings panel.** That is #327 and it needs its own design: a panel
  relocation, a control-type change, a cost model for live recompute, and an
  animated transition are four things, not one. This repo's own lesson —
  _"do the registry first and alone"_ — applies.
- **No scoped/per-selection projection.** The sweep's scopes were computed from
  faces _inside one folder_, which is not what the app does; today it projects
  the whole library and hides the rest, deliberately
  (`server/db/projections.js:181`). John's per-album picks differing from his
  whole-library pick is a hint that per-selection maps may be worth having, but
  it is a separate finding and a separate issue.
- **No three.js.** `ScatterCanvas` is canvas 2D and already draws 5,499 points
  with crops. Any animation wanted later is a lerp between two coordinate
  arrays keyed by `personId`. Measure before taking a 3D engine for 255 points.
