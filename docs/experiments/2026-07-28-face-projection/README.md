# Which 2-D projection can support a lasso-merge over faces?

Measurements taken 2026-07-28 while designing #232 (a face map with lasso
selection) and #165 (the embedding scatter). Recorded here because the answer
was **not** the one either issue assumed, and because the quality test below
should become a permanent gate rather than a one-off.

Run against a real library (`~/.autogallery/index.db`, read-only), on
darwin/arm64, Node 24. Numbers on other machines will differ; the _ranking_ is
the durable part.

## The library these numbers come from

|                                     |                                                                  |
| ----------------------------------- | ---------------------------------------------------------------- |
| Faces detected (`buffalo_s`, 512-d) | 118,371                                                          |
| Faces assigned to a person          | 48,585 (41%)                                                     |
| **Faces in no group at all**        | **69,786 (59%)**                                                 |
| Persons                             | 25,758 — of which **6 are named**                                |
| Group sizes                         | 20,259 singletons · 4,777 with 2–5 · 722 with >5 · biggest 3,512 |

The 59% ungrouped is not a projection problem — it means a grouping pass has
never completed over the whole library. It matters here only because it caps
what any map can show, and the view has to say so.

## Question 1 — what does it cost to project 25,758 person centroids?

A "person centroid" is the mean of that person's dequantized face vectors,
re-normalized to unit length.

### umap-js (Apache-2.0)

Licence note, because this file initially recorded it wrong: umap-js's
`package.json` declares `"license": "MIT"`, but the shipped `LICENSE` file is
the **Apache License 2.0** and every source file carries
`Copyright 2019 Google LLC ... Licensed under the Apache License, Version 2.0`.
The file and the headers control. Apache-2.0 is permissive and fine to ship
inside an MIT app, but its §4 adds attribution obligations MIT does not have,
so a `THIRD-PARTY-NOTICES` surface is part of adopting it. `@keckelt/tsne` is
MIT (verified) and `ml-pca` is MIT.

| points                               | kNN + graph | epochs | total      | worst `step()` | peak RSS |
| ------------------------------------ | ----------- | ------ | ---------- | -------------- | -------- |
| 3,000                                | 1.0 s       | 1.4 s  | 2.4 s      | 5 ms           | 670 MB   |
| **5,499** (= persons with >=2 faces) | **2.1 s**   | 1.9 s  | **4.0 s**  | 8 ms           | 824 MB   |
| 25,758 (all persons)                 | **14.1 s**  | 6.4 s  | **20.5 s** | 34 ms          | 1,825 MB |

The 5,499 row is the one that matters and it was added last, after
`ARCHITECT-REVIEW.md` argued from an interpolation that `minFaces: 2` should be
the default. The interpolation predicted ~2 s / ~4 s / ~750 MB; measurement
gave 2.1 s / 4.0 s / 824 MB. **Restricting the map to people seen more than
once turns the 14.1 s unyieldable block into 2.1 s and halves peak memory** —
and it is the same 5,499 people that are the only plausible merge candidates.

**The 14.1 s is one unyieldable call.** `initializeFit` takes no callback, so
there is no yield point to budget — the #231 fix does not apply, and this
cannot run on the API server's event loop. It also cannot be cancelled
cooperatively during that phase. Both facts argue for a `worker_threads`
worker, where the heap is separate and cancel is `terminate()`.

Reducing 512 → 64 dims first with a Johnson–Lindenstrauss random projection
(`umap-jl.mjs`) buys 20.5 s → 13.2 s and 1,825 → 1,344 MB. Not worth the code
or the unvalidated fidelity question at this size; documented as the lever to
pull if the library outgrows ~20 s.

### DruidJS 0.8.0 (LGPL-3.0-or-later)

Every algorithm, `metric: cosine`, `d: 2`, defaults otherwise.

| algorithm | 2,000           | 8,000              | 25,758                     |
| --------- | --------------- | ------------------ | -------------------------- |
| PCA       | 0.4 s / 315 MB  | 1.4 s / 458 MB     | **4.5 s / 808 MB**         |
| FASTMAP   | 0.0 s (2 NaN)   | 0.0 s (1 NaN)      | **0.1 s / 594 MB (1 NaN)** |
| SQDMDS    | 2.7 s / 390 MB  | 12.5 s / 493 MB    | **44.1 s / 923 MB**        |
| MDS       | 1.7 s / 444 MB  | 17.6 s / 2,006 MB  | not run (O(n²) memory)     |
| TopoMap   | 2.1 s / 655 MB  | 43.1 s / 4,148 MB  | not run                    |
| UMAP      | 8.4 s / 657 MB  | 125.7 s / 5,073 MB | >25 min, no result         |
| TriMap    | 10.6 s / 368 MB | 137.3 s / 588 MB   | not run                    |
| TSNE      | 15.1 s / 608 MB | >240 s             | not run                    |
| ISOMAP    | 13.9 s / 561 MB | >10 min            | not run                    |
| LLE       | 35.1 s / 650 MB | >10 min            | not run                    |
| SAMMON    | 35.3 s / 374 MB | >10 min            | not run                    |

**DruidJS's UMAP is ~20× slower than umap-js and the cause is identifiable:**
it does exact kNN with a `BallTree`, and a BallTree in 512 dimensions
degenerates to near-linear scan — hence 5 GB at 8,000 points. umap-js uses
random-projection trees + NN-descent, i.e. approximate kNN. Same algorithm,
different neighbour search. It is _not_ an artifact of progressive stepping:
the umap-js timings above include all 200 `step()` calls.

FASTMAP emitting non-finite coordinates at every size is disqualifying on its
own — a NaN is a point that cannot be drawn or hit-tested.

## Question 2 — does the projection actually co-locate the same person?

Speed is not the axis that matters. The lasso only works if two _groups of the
same human_ land near each other. `twin-rank.mjs` measures that directly:
split one person's faces into two halves, treat each half as its own person,
and report the 2-D rank of each half's twin among all points. Rank 1 means
"my nearest neighbour on the map is my other half".

### Easy split — interleaved (722 pairs + 3,000 distractors)

| algorithm    | twin is #1 | top-5 | median rank | time  |
| ------------ | ---------- | ----- | ----------- | ----- |
| SQDMDS       | 100%       | 100%  | 1           | 6.7 s |
| MDS          | 100%       | 100%  | 1           | 9.4 s |
| umap-js UMAP | 25.1%      | 62.4% | 4           | 4.3 s |
| PCA          | 11.1%      | 27.8% | 16          | 1.0 s |
| FASTMAP      | 10.2%      | 23.0% | 27          | 0.0 s |

**These numbers are misleading and are kept only as a warning.** Interleaved
halves share day, lighting and angle, so their centroids are nearly identical
in 512-d, and any distance-preserving method keeps near-identical points
near-identical. It measures a triviality, not the task.

### Hard split — earliest half vs latest half, ≥24 h apart

Different day means different light, clothes and angle — which is _why_
clustering split the person in the first place. This is the real case.

36 pairs + 4,000 distractors (persons with ≥4 faces):

| algorithm          | twin is #1 | top-5     | top-20 | median rank | p90   | time   |
| ------------------ | ---------- | --------- | ------ | ----------- | ----- | ------ |
| **t-SNE**          | **62.5%**  | **93.1%** | 94.4%  | **1**       | **4** | 74.1 s |
| **UMAP (umap-js)** | **27.8%**  | 58.3%     | 83.3%  | 4           | 52    | 3.9 s  |
| MDS                | 2.8%       | 11.1%     | 27.8%  | 57          | 268   | 4.5 s  |
| PCA                | 2.8%       | 6.9%      | 29.2%  | 56          | 200   | 0.8 s  |
| SQDMDS             | 0.0%       | 0.0%      | 0.0%   | 1822        | 3170  | 6.2 s  |

A stricter variant (≥6 faces, 15 pairs) agrees on the ranking:
t-SNE not run, umap-js 30.0%, MDS 10.0%, PCA 6.7%, SQDMDS 0.0%.

### What this says

- **The neighbour-graph family is the only one that works.** t-SNE and UMAP
  optimise local neighbourhood membership, which is literally the question
  "which other group is mine". Distance-preserving methods (MDS, SQDMDS, PCA)
  score at or near chance.
- **SQDMDS is the trap.** Best on the easy test (100%), worst on the real one
  (0.0%, median rank 1822). Any future benchmark that uses an easy split will
  pick it.
- **t-SNE is 2.2× better than UMAP and 19× slower**, and it is O(n²): 74 s at
  4,072 points extrapolates to roughly 47 minutes at 25,758.
- **No method is a magic co-locator.** UMAP's p90 rank of 52 is the honest
  argument for a lasso instead of an automatic threshold.

### The size that makes t-SNE affordable

20,259 of 25,758 persons are singletons — mostly strangers in the background
of one photo, and not merge candidates. The **5,499 persons with ≥2 faces** are
the real working set, and at ~5,500 points t-SNE costs roughly 2 minutes. So a
"minimum faces" filter is not a nicety; it is what puts the best-scoring
algorithm within reach.

## Caveats

- **36 pairs is a small sample.** The ranking is clear (0.0% vs 93.1% is not
  noise) but these are not numbers to tune parameters against. This test should
  move into the repo and run over a larger synthetic-split set.
- Single machine, single library, one face model (`buffalo_s`, 512-d).
- The hard split uses `COALESCE(taken_at, mtime)`, so photos with no EXIF date
  fall back to file mtime and their "time gap" may be fictional.
- DruidJS UMAP at 25,758 was abandoned after 25 minutes rather than run to
  completion; it is recorded as "no result", not as a measured time.

## Files

|                      |                                                 |
| -------------------- | ----------------------------------------------- |
| `umap-bench.mjs`     | umap-js cost at a given point count             |
| `umap-jl.mjs`        | same, after a 512→N random projection           |
| `druid-bench.mjs`    | one DruidJS algorithm at a given point count    |
| `twin-rank.mjs`      | quality, interleaved split (the misleading one) |
| `twin-rank-hard.mjs` | quality, time-gap split (the real one)          |

Run from the repo root so `better-sqlite3` resolves, e.g.:

```bash
node --max-old-space-size=8192 docs/experiments/2026-07-28-face-projection/twin-rank-hard.mjs UMAPJS 4000 4 24
#                                                                                  algorithm ^   ^     ^  ^ min gap (hours)
#                                                                                   distractors   min faces
```

`umap-js`, `@saehrimnir/druidjs` and `better-sqlite3` must be installed;
DruidJS and umap-js were installed in a scratch directory for these runs and
are **not** dependencies of the app.
