# The Face Map's settings become a live side panel

Design for **#327**, and it absorbs **#287** (settings not persisted).

The feature exists because of a measurement, not a preference. #326 established
that the best `nNeighbors` **cannot be predicted** from anything the index can
count: two albums of nearly the same size (42 and 53 people) want values 2.4×
apart, a power law fits at R² = 0.11, and every structural measure correlates
r ≈ 0.2 with the values John actually picked. If the right value is
content-dependent and unguessable, **the fix is a control that finds it in
seconds, not a cleverer default.** That is this issue.

---

## What was measured first

Everything below is grounded in runs against the real library. Three findings
shaped the design, and two of them killed features that were in the original
request.

### 1. Live is not a performance problem

One full cold projection, 200 epochs, real person-centroids:

| people | total  | neighbour graph | layout |
| ------ | ------ | --------------- | ------ |
| 21     | 46 ms  | —               | —      |
| 54     | 71 ms  | 63 ms           | 18 ms  |
| 109    | 118 ms | —               | —      |
| 203    | 201 ms | 151 ms          | 53 ms  |
| 852    | 842 ms | —               | —      |

Fitting `ms = 3.29 × n^0.80` — **sublinear**, which contradicts
`algorithms.js`'s note calling the projection superlinear and quoting "20s with
singletons". Extrapolated: 1,000 → 0.8 s, 5,499 → 3.1 s, 25,758 → **10.7 s**.
That note should be corrected when this ships.

### 2. The neighbour graph is reusable, and one build covers the whole slider

`setPrecomputedKNN` is public and `initializeFit` honours it
(`if (!this.knnIndices && !this.knnDistances)`). Building the kNN once at
k = 60 and slicing rows per request:

| nNeighbors | with cached kNN | cold    |
| ---------- | --------------- | ------- |
| 15         | 61 ms           | ~203 ms |
| 30         | 83 ms           | ~203 ms |
| 60         | 117 ms          | ~203 ms |

**Slicing is exact** — a kNN list is distance-sorted, so the first k entries
_are_ the k nearest. One build at the schema's maximum therefore serves every
value the slider can produce.

**The trap:** `fuzzySimplicialSet` passes `nNeighbors` to `smoothKNNDistance`
while reading the _stored_ rows. Set a k = 60 kNN and ask for `nNeighbors = 15`
and the sigmas target one k while the graph is built from another — a wrong
graph, silently. The rows must be sliced by the caller before
`setPrecomputedKNN`.

### 3. Animation and warm start are both refuted

Consecutive layouts are not related. Residual after removing rotation,
reflection and scale (Procrustes; 0 = identical, 1.41 = unrelated), 203 people:

```
nNeighbors 30 -> 31   0.204        same params, new seed   0.800
nNeighbors 30 -> 36   0.664        same params, same seed  0.000
nNeighbors 30 -> 50   0.235
```

Not even monotonic — 30 → 36 moves points three times further than 30 → 50.
UMAP offers no continuity guarantee across hyperparameters, so **tweening
point-to-point between two runs is a scramble that looks like an animation and
communicates nothing.**

Warm-starting from the previous embedding was then tried, since it is the
standard remedy. It is feasible through the **public** API alone —
`getEmbedding()` returns the live array and `initializeOptimization` captured
that same reference as `headEmbedding`/`tailEmbedding`, so mutating rows in
place after `initializeFit` reaches the optimiser. It does not work:

| setting                     | vs the map you were on | vs the TRUE 36 map | time   |
| --------------------------- | ---------------------- | ------------------ | ------ |
| cold, lr 1.0, 200ep (today) | 0.664                  | **0.000**          | 183 ms |
| warm, lr 1.0, 200ep         | **0.792**              | 0.449              | 190 ms |
| warm, lr 0.3, 100ep         | 0.205                  | 0.674              | 173 ms |
| warm, lr 0.1, 50ep          | 0.148                  | 0.679              | 140 ms |
| warm, lr 0.05, 50ep         | 0.111                  | 0.687              | 149 ms |

At full learning rate warm start is **worse than cold**:
`initializeOptimization` resets `alpha = learningRate`, so the annealing washes
the initial positions out and lands 0.449 from the true answer as well.

Turning the rate down fixes continuity — but the two columns move in lockstep
and **their sum is ~0.83 at every setting.** Continuity is bought by _not
applying the parameter change_. At lr 0.1 the map is still essentially the
nNeighbors-30 map, so the slider would feel smooth and do almost nothing, and
the user would be lassoing groups from a map that is not the map for the
parameters displayed. That is the #325 failure family: a view quietly
presenting itself as something it is not.

**Decision: no warm start, no position tween. Instant cold redraw.** The map on
screen is always the true map for the parameters shown.

> **Reversed in half, 2026-08-07 — read this before citing the line above (#347).**
>
> **The position tween SHIPPED.** John asked for it in as many words —
> _"I don't see the animation. I want to see the animation between changes"_ —
> after driving the panel with the instant redraw in place. `FaceMapView.svelte`
> now staggers points between parameter sets, paired by `personId`, over a
> Procrustes alignment (`scatter/align.js`).
>
> **Warm start stays rejected.** That half was not overturned and the table
> above is still the reason: continuity bought by lowering the learning rate is
> continuity bought by not applying the parameter change, and the invariant in
> the sentence above — the map on screen is the true map for the parameters
> shown — is exactly what a tween preserves and a warm start does not. The
> projection is still computed cold; only the journey to it is animated.
>
> **The 0.664 residual is why alignment was needed, not an argument against the
> tween.** A cold UMAP run is free to rotate and reflect the whole embedding, so
> tweening raw coordinates animates a spin nobody asked for. Aligning on the
> paired points first is what makes the movement read as "these people moved"
> rather than "the map turned over".

---

## What we build

### 1 · The panel

Settings move out of the gear popover into a **side panel** occupying roughly
15% of the view width, so the map stays visible while parameters change. The
popover is removed, not kept alongside — two ways to reach the same settings is
how they drift apart.

Number inputs become **sliders with a live, editable numeric field**. Today
`<input type="number">` will not let you get from `5` to `50` by typing a `0`
after the 5, which is the single most-cited annoyance in the report.

The panel is a **settings panel**, not a view, under `docs/UI-CONTRACTS.md` §3:
it holds parameters, not photos. If it ever grows a people-browsing surface it
becomes a view and moves to the main area.

### 2 · The live boundary is self-calibrating

**Time the last run and use that**, rather than hardcoding "live below N
people":

- last run under **400 ms** → the map follows the slider, debounced on `input`;
- at or over it → the slider moves a number only, and **Apply** starts a normal
  job.

This lands correctly at every library size without a constant that goes stale.
203 people are live at 83 ms; 25,758 are a job at ~11 s; nobody guesses where
the line is. A library that grows past the boundary crosses it by itself.

**Contract 2 is intact above the line**: Apply creates a job that appears in the
JobsPanel, reports proportional progress, and is cancellable. Below the line
nothing is a job because nothing takes long enough to need one — a job row that
appears and completes in 83 ms is noise, and "if there is nothing pending, start
no job" is the same rule applied to a different quantity.

**`minFaces` is always Apply-driven, at any size.** It changes the member set,
so it invalidates both the centroid query and the cached kNN — it is the
expensive parameter, and it is also the one where "how many people am I about to
map" deserves a deliberate press.

### 3 · Preview must not write runs

Live sliding needs a path that returns coordinates **without creating a run**.
Forty rows in `projection_runs` during one drag would let `pruneRuns(keep: 3)`
evict the maps the user actually built — a data-loss-shaped bug caused by a
convenience feature.

So: a preview path returns points only. **Apply** goes through the existing
`POST /api/projections`, which persists as it does today.

**Because runs are seeded and deterministic, Apply reproduces exactly what the
preview showed** — the map does not jump when you commit. This property is what
makes the whole design safe, and it is a second reason warm start had to go: a
path-dependent preview could never offer it.

### 4 · Settings persist (#287)

The panel's values survive a reload. #287 is filed separately at `priority:
low`; it should be closed by this work rather than fixed twice, because a live
panel whose settings reset on every reload is a worse version of the problem it
was filed for.

---

## What this deliberately does not do

- ~~**No animated transition between parameter sets.**~~ **Overturned and
  built** — John asked for the animation after seeing the instant redraw, and
  it shipped as a Procrustes-aligned position tween. See the dated note above
  the "What we build" heading. It was not smuggled in; it was requested.
- **No warm start.** Refuted above, with the numbers, so that nobody re-derives
  it — the same reason #326's refutation lives in a comment with a test holding
  it in place.
- **No three.js.** Never justified. `ScatterCanvas` is canvas 2D and already
  draws 5,499 points with face crops. The measured bottleneck is the projection,
  not the rendering, and a 3D engine addresses neither.
- **No scoped/per-selection projection.** #326's sweep hinted that per-album
  maps may be worth having, but that is a separate feature and a separate issue.
