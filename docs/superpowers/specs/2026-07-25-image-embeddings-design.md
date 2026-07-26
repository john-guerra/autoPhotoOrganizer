# Image embeddings over cached thumbnails — design (#161)

**Status:** SHIPPED 2026-07-25 (2.18.30) — **partly superseded by the
implementation**, see [Superseded 2026-07-25](#superseded-2026-07-25) at the
bottom before trusting anything above it. In particular §C's second host was
built and then DELETED, and the premise it rested on ("the prebuilt native
addon ships no CoreML on any platform") is FALSE.

**Issue:** [#161](https://github.com/john-guerra/autoPhotoOrganizer/issues/161)
**Depends on:** #160 (sidecar + `runSweep`) — closed and shipped
**Feeds:** #162 (near-duplicates), #163 (semantic clusters), #164 (zero-shot
tags), #165 (embedding scatter)
**Parent design:** `2026-07-24-ml-signals-design.md` §3–§4

Compute a vision embedding for every photo, in the background, without ever
making the app feel slower. This slice ships no navigation feature of its own —
it is the substrate the four issues above consume.

## Corrections to the issue as filed

Three premises in #161 did not survive contact with the code. They are recorded
here because each one changes the design, not just the implementation.

**1. There is no warm thumbnail cache to read.** #161 says "the cache already
holds a 320 px JPEG". `thumbsDir()` is written from exactly one place —
`GET /api/thumb/:id` (`server/api.js:906`) — and nothing pre-warms it. On a
114k-photo library the cache holds only what the user has actually scrolled
past. So the sweep cannot be a pure consumer of the cache; the acceptance
criterion "a full backfill drains to zero pending" is unreachable if it is.
**Decision: the sweep generates and writes the 320 thumb on a miss**, making the
backfill a producer into the cache. The one-time decode cost becomes a lasting
benefit — the grid ends up warm across the whole library.

**2. `ml_status` does not exist.** #160's `runSweep` was written against it —
its `markFailed` contract and stall guard assume a sentinel table — but the
table was never created. #161 is where it lands.

**3. `@huggingface/transformers` re-arms #67.** Version 4.2.0 pins
`onnxruntime-node` to _exactly_ `1.24.3`; this repo declares `^1.27.0`. npm
resolves that to a **nested second copy** of the native addon, which both
`asarUnpack: "node_modules/onnxruntime-node/**"` and `electron-rebuild -w
onnxruntime-node` glob straight past — a Node-ABI binary shipped into an
Electron build, which is precisely how #67 crashed on launch.

## Decisions (approved 2026-07-25)

| Decision     | Choice                                                                                                                                                                                  | Why                                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model        | **SigLIP base patch16-224**, user-switchable                                                                                                                                            | ~76% vs ~63% zero-shot ImageNet. #164's open-vocabulary tags are the consumer that most needs the accuracy. Costs ~4× CLIP-B/32 per photo.                                      |
| Runtime      | **`@huggingface/transformers` v4**                                                                                                                                                      | Owns preprocessing constants, model download/caching, and the BPE tokenizer #164 needs. Hand-rolled normalization is silently wrong — vectors that look fine and cluster badly. |
| Input        | **320 px cached thumb, generated on miss**                                                                                                                                              | See correction 1.                                                                                                                                                               |
| Acceleration | ~~**WebGPU in an Electron renderer**, ONNX child otherwise~~ **REVERSED — see "Superseded" below.** The ONNX child selects its own execution provider; darwin leads with CPU, measured. | See "Two hosts" below, then the reversal.                                                                                                                                       |
| CPU share    | **User-choosable, default half the cores**                                                                                                                                              | The sidecar being a separate process does not stop it competing for cores.                                                                                                      |
| Old vectors  | **Kept, sized, manually purgeable**                                                                                                                                                     | Switching back after an A/B is then free. ~87 MB per model at 114k photos.                                                                                                      |
| Dev mode     | **Silent fallback to the ONNX child**                                                                                                                                                   | The whole sweep is developable and testable without launching Electron.                                                                                                         |
| ORT version  | **Try `overrides` to 1.27, fall back to 1.24.3**                                                                                                                                        | One copy is what matters for packaging; which version is secondary.                                                                                                             |

### Two overrides of the parent design, recorded deliberately

The program design (`2026-07-24-ml-signals-design.md`) lists **GPU/WebGPU
inference** under "Out of scope", and its resolved decisions name a Node child
process as _the_ runtime. Both are overridden here at John's explicit direction:

- **WebGPU is in scope for this issue**, not a follow-up.
- **A second execution host is added.** The Node child is not removed — it
  remains the fallback, and the only host under `npm run dev`.

> **FALSE PREMISE — read the "Superseded" section at the bottom.** The
> paragraph below is the claim the whole two-host design rested on, and it is
> wrong. It is left in place, not edited, so the reversal has something to
> point at.

**Two different runtimes, and the distinction is load-bearing.** "No GPU on
macOS" is a fact about **`onnxruntime-node`'s execution providers**: the
prebuilt native addon ships **no CoreML on any platform**, so Apple Silicon
gets CPU only (DirectML ships on Windows, CUDA on Linux x64). It says nothing
about **Chromium's WebGPU**, which is a separate implementation reached through
the renderer — the same path transformers.js demos use for SAM, already proven
in practice.

So the two findings agree rather than conflict: ORT's execution providers give
us nothing on Apple Silicon, which is exactly why the GPU has to be reached
through a renderer instead. The app is already Electron, so that host is
available.

This is recorded so it reads as a decision rather than drift.

## Architecture

```
scan ──▶ upsertScan ──▶ (post-scan, fire-and-forget, single-flight)
                          ├─▶ enrich sweep     (exists)
                          ├─▶ hashAllPending   (exists)
                          └─▶ embedAllPending  (new) ── runSweep ──┐
                                                                   │
   worklist = partial index over photos LEFT JOIN photo_embeddings │
             (active model) LEFT JOIN ml_status (stage='embed')    │
                                                                   ▼
                                                        thumbSource.js
                                               cache hit → read 320 jpeg
                                               miss      → generate + WRITE
                                                                   │
                                                    MLService.embedImages()
                                                                   │
                        ┌──────────────────────────────────────────┴───┐
                        ▼                                              ▼
              WebGpuMLService                              OnnxMLService
       hidden BrowserWindow, IPC                    child process, stdio
       transformers.js device:'webgpu'              transformers.js device:'cpu'
       (Electron only)                              (always available)
                        └──────────────────────────────────────────┬───┘
                                                                   ▼
                                              photo_embeddings (int8, L2-normed)
                                              ml_status        (failures only)
```

### A. Input pipeline — `server/ml/thumbSource.js`

**First, kill the duplicated cache key.** `thumbCachePath(photo, size)` moves
into `server/lib/cachePaths.js`; `server/api.js:906` and
`server/lib/cacheStats.js:19` both route through it. `cacheStats.js`'s comment
admitting the formula is "kept in sync manually" is deleted, not updated. This
is #161's explicit ask, and it must land _before_ anything becomes the fourth
copy.

`thumbBytes(photo)` then:

1. Computes `thumbCachePath(photo, 320)`. Hit → read and return.
2. Miss → `processing.videoThumb(path, 320)` for video, else
   `processing.thumbnail(path, 320)`; write via the same `tmp` + `rename`
   atomic dance the endpoint uses; return the bytes.

Videos are included: their poster frame is their thumbnail, and the generation
path already handles them, so the marginal cost is zero.

**320, not a new 224 bucket.** 320 is what the grid already requests, so the
write we pay for is a write the user benefits from. The processor resizes
320 → 224 anyway, and it does so from a larger source, which is the correct
direction. Adding a 224 bucket would fragment the cache and warm nothing.

⚠️ `pruneOrphanedCache` (`cacheStats.js:147`) deletes any file under `thumbs/`
not in its expected key set, regardless of extension. Models and any vector
sidecar go in their own directories under `cacheRoot()` — never `thumbs/`.

### B. Storage — `server/db/embeddings.js`

```sql
CREATE TABLE IF NOT EXISTS photo_embeddings (
  photo_id   INTEGER NOT NULL REFERENCES photos(id),
  model      TEXT    NOT NULL,   -- upgrading the model is new rows
  dim        INTEGER NOT NULL,
  scale      REAL    NOT NULL,   -- int8 -> float reconstruction
  vec        BLOB    NOT NULL,   -- dim int8 bytes
  created_at INTEGER NOT NULL,
  PRIMARY KEY (photo_id, model)
);

CREATE TABLE IF NOT EXISTS ml_status (
  photo_id   INTEGER NOT NULL REFERENCES photos(id),
  stage      TEXT    NOT NULL,   -- 'embed' today; 'faces' later
  model      TEXT    NOT NULL,
  state      TEXT    NOT NULL,   -- 'failed'
  attempts   INTEGER NOT NULL DEFAULT 1,
  error      TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (photo_id, stage, model)
);
```

**Composite primary key, not `photo_id` alone** as #161 sketches — the whole
point of the `model` column is that two models' vectors coexist, which a
`photo_id` PK forbids. `ml_status` is keyed by model for the same reason: a
photo that fails under one model is not thereby failed under another.

**Quantization.** L2-normalize the float32 vector, then quantize to int8 with a
per-vector scale (`scale = max(|v|) / 127`). Because every stored vector is
unit-length, **cosine similarity reduces to the int8 dot product** — no
per-comparison division, and the brute-force scan stays a single tight loop over
one typed array. `scale` is stored anyway so the round-trip is exactly testable
and so a future consumer can reconstruct true floats.

At 114k × 768 int8 that is **~87 MB per model** — one typed array, well inside
the "no vector database" budget the parent design set.

**Invalidation.** `upsertScan`'s `ON CONFLICT` (`server/db/photos.js:39-43`)
today nulls only `content_hash` when size or mtime change. Embeddings must join
that `CASE`: an edited photo otherwise keeps a stale vector forever, and nothing
else will ever notice. Implemented as a delete of the photo's
`photo_embeddings` and `ml_status` rows in the same transaction.

**Worklist index.** A partial index in the `schema.js` fingerprinted-index
style, covering photos with no embedding for the active model and no `failed`
sentinel. `queryPlan.test.js` gets a case asserting the worklist query uses it,
or the index rots silently as the parent design warns.

### C. Two hosts behind `MLService`

`MLService` (`server/ml/MLService.js`) is already the abstract seam, and its
`embedImages(paths)` signature already exists. Both hosts implement it; nothing
downstream knows which one ran.

**`OnnxMLService`** (extend the existing file). Gains `loadModel(modelId)` and a
real `embedImages`. The worker (`server/ml/worker/index.js`) loads
`@huggingface/transformers`, holds the **vision encoder only** — the text
encoder stays unloaded until #164 needs it, saving both download and RAM — and
unloads after an idle timeout. Its existing `health` op already reports
`providers`; extend it to _select_ the best available execution provider
(DirectML on Windows, CUDA on Linux x64) and report which one it actually chose.
Session options cap `intraOpNumThreads` to the configured CPU share.

**`WebGpuMLService`** (new, `server/ml/WebGpuMLService.js`). Owns a hidden
`BrowserWindow` (`show: false`) loading a small bundled local page — no CDN, the
CSP forbids it — which imports transformers.js at `device: 'webgpu'`. Requests
cross by IPC; thumbnail **bytes** are passed as `Uint8Array` (structured clone),
and the renderer does `createImageBitmap(new Blob([bytes]))`. Passing bytes
rather than paths keeps the renderer off the filesystem entirely, so
`safeResolve` has no new surface to guard.

**Injection, so `server/` never imports `electron`.** `createApp()` grows an
options bag: `createApp({ ml } = {})`. `electron/main.js:4` already imports
`createApp` directly (the Express server runs _in_ the main process), so it
constructs the WebGPU host and passes it in. Standalone `server/index.js` passes
nothing and gets `OnnxMLService`. This mirrors the `ProcessingService` seam
exactly and is what makes the dev-mode fallback automatic rather than
conditional.

**Host selection order:** injected WebGPU host, if it reports WebGPU actually
available → ONNX child. A WebGPU host that fails to initialize falls back once,
reports the fallback, and does not retry per batch.

### D. Sweep — `server/ml/embedSweep.js`

`embedAllPending(db, { ml, processing, job })` on the shared `runSweep`:

- `nextBatch` — the partial-index query, re-queried each pass, batch of ~16.
- `process` — `thumbBytes` for each row, one `ml.embedImages` call for the
  batch, one transaction writing all vectors.
- `markFailed` — insert/bump the `ml_status` row. This is what removes the
  photo from the worklist, which is what lets the loop terminate; `runSweep`'s
  stall guard throws loudly if it doesn't.
- `folderOf` — the folder `abs_path`, so an unmounted drive **pauses** the
  sweep rather than marking every photo permanently failed. This is #169's
  lesson, and `runSweep` already implements the classification.

Single-flight per stage. Started post-scan, fire-and-forget, beside
`hashAllPending`. Registered in the job registry so it reports progress and
cancels through the JobsPanel like every other job.

### E. Settings and the never-fail-silently contract

A new ML section (server: `GET/PUT /api/ml/settings`, `GET /api/ml/stats`)
surfacing:

- **Model** — SigLIP base patch16-224 (default) or CLIP ViT-B/32 (fast), with
  dimension and download size shown. Switching sets the active model and starts
  a fresh backfill; the previous model's rows are kept.
- **CPU share** — default half the physical cores.
- **Active provider** — read-only, honestly labelled. Under `npm run dev` this
  reads "CPU (WebGPU unavailable outside the app)". It must never claim an
  accelerator that isn't running.
- **Per-model vector storage** with a delete button, in the shape of the
  existing cache panel.
- **Counts** — "12,431 of 114,125 embedded, 37 failed", per active model.
  Pending and failed are distinct and both visible; this is the specific way
  pre-2.17.14 `backupCoverage` misled.

Failures the user can trigger, each with a specific message on the control that
triggered it: model download failed (what, how big, retry), sidecar/renderer
crashed (name the stage, offer retry, app stays fully usable without ML), drive
unmounted mid-sweep (paused, not failed — resumes on remount).

### F. Packaging

`overrides: { "onnxruntime-node": "^1.27.0" }` to collapse the nested copy. If
transformers.js v4 proves incompatible with ORT 1.27, align the top-level
dependency **down** to 1.24.3 instead and record why — one copy is the
requirement; the version is negotiable. Either way `npm ls onnxruntime-node`
must show exactly one, and that assertion belongs in the plan's verification
step, because it is the check that would have caught #67.

`@huggingface/transformers` and its `sharp` dependency are already covered by
the existing `asarUnpack` globs. Models download to `~/.autogallery/models/`,
never bundled, never under `thumbs/`.

## Testing

Per `docs/TESTING.md`, at the tier that would catch it:

- **vitest, pure** — quantization round-trip (normalize → int8 → reconstruct,
  bounded error); cosine-as-dot-product equivalence for unit vectors; the
  batch-to-rows mapping; host selection given a fake capability probe.
- **vitest, db** — `photo_embeddings` upsert and the composite key; `ml_status`
  removing a row from the worklist (the property `runSweep` depends on);
  `upsertScan` clearing embeddings on an mtime change; `queryPlan.test.js` for
  the worklist index.
- **vitest, sweep** — a stub `MLService` failing on a chosen row: sentinel
  written, loop still drains to empty. An unreachable folder: paused, **nothing
  marked**. The suite never downloads a model, never spawns a child, never
  opens a BrowserWindow.
- **e2e** — the settings surface: counts render, a model switch is reflected,
  the provider label is present. `trackPageErrors(page)` in every spec.
- **Measured, recorded in `CHANGELOG.md`/the issue** — cost per photo on the
  real library for the chosen model on both hosts. This is #161's first
  acceptance criterion and cannot be satisfied by a test.
- **Live verification** — a real backfill running while scrolling the grid, per
  the acceptance criterion's "verify against a live scroll, not just a test".

## Build order

Four separately-committable phases, each green before the next:

1. **Cache-key extraction + `thumbSource`** — pure refactor plus one new
   module. No models, no schema. Ships value immediately (kills the
   hand-synced formula).
2. **Schema + quantization** — `photo_embeddings`, `ml_status`, the partial
   index, `upsertScan` invalidation, quantization helpers. All unit-tested with
   no inference at all.
3. **`OnnxMLService` inference + `embedAllPending`** — real embeddings on CPU,
   end to end, sweeping and draining. This is the first phase that produces
   vectors, and the first that can be measured.
4. **`WebGpuMLService` + settings UI + packaging** — the Electron renderer
   host, the settings surface, and the `overrides` fix.

## Out of scope for #161

Consuming the vectors. Near-duplicates (#162), clusters (#163), tags (#164), and
the scatter (#165) each own their own retrieval path. #161 ends when every photo
has a vector, the counts are honest, and the sweep never makes the app feel
slower.

## Superseded 2026-07-25

Everything above is the design as approved. This section is what the
implementation actually found, recorded here because three shipped source
comments cite it and because the working notes it originally lived in
(`.superpowers/sdd/2026-07-25-image-embeddings/`) are **gitignored** — they
vanish with the worktree, and a comment pointing at them points at nothing.

### The second host was built, then deleted (§C, and the "Acceleration" row)

`WebGpuMLService` — a hidden Electron renderer running transformers.js on
WebGPU — was implemented as specified, reviewed, and **removed in the same
session** (commit `36d8b8b`, "revert(ml): delete the WebGPU renderer host").
Review found three Criticals in it, one of which is the failure this whole
feature most needs to avoid:

1. The image bytes went through a JSON round-trip, so the renderer built its
   `Blob` from the STRING `"255,216,255,…"`. Every embed fails — and the sweep
   then writes a PERMANENT "cannot be read" sentinel for every photo in the
   library.
2. The failure path nulled the window reference without `destroy()`: one
   leaked Chromium renderer PER PHOTO, because the sweep retries a failed
   batch row by row.
3. The hidden window counted in `getAllWindows()`, so on macOS closing the
   main window and clicking the dock reopened nothing — a force-quit on
   EVERY packaged launch, ML or not.

The replacement is explicit execution-provider selection inside the ONNX child
that already existed: `server/ml/worker/devices.js` (the candidate order) and
`loadWithBestDevice()` in `server/ml/worker/index.js` (try each in turn,
validated by a REAL forward pass at the REAL batch size). `electron/main.js`
has exactly one `BrowserWindow` again, so Critical 3 is gone by construction.

### The premise was false

The spec asserts as fact that "the prebuilt native addon ships **no CoreML on
any platform**", sourced from onnxruntime.ai's docs page and never checked
against the installed binary. Checked now:

```
onnxruntime-node listSupportedBackends()
  -> [{name: "cpu", bundled: 1}, {name: "webgpu", bundled: 1}, {name: "coreml", bundled: 1}]
```

and transformers.js 4.2.0 (`dist/transformers.web.js`) pushes `coreml` on
darwin, `dml` on win32, `cuda` on linux/x64, then `webgpu`, then `cpu` — in the
NODE environment. The worker's hardcoded `device: "cpu"` was the only reason
this app was on CPU. This is exactly the "verify the lowest layer first" rule in
CLAUDE.md, skipped: one `listSupportedBackends()` call would have prevented a
whole host from being designed and built.

### The measurement, which reversed the instruction it was gathered under

The instruction was "use the GPU". The numbers said otherwise, and the numbers
won. darwin/arm64, 2026-07-25, each candidate forced explicitly (no
fallthrough) via the `ML_INTEGRATION` benchmark in
`server/ml/OnnxMLService.test.js`; each re-run twice:

**CLIP ViT-B/32, batch=4, threads=2**

| EP     | ms/photo  | Note                              |
| ------ | --------- | --------------------------------- |
| coreml | —         | BROKEN (throws on real inference) |
| webgpu | 22.79     |                                   |
| cpu    | **12.98** | fastest                           |

**SigLIP base patch16-224 (the default model), batch=16 (the sweep's real
`limit`), threads=2 — the production configuration, not a cheaper stand-in**

| EP     | ms/photo  | Note                   |
| ------ | --------- | ---------------------- |
| coreml | —         | BROKEN, same signature |
| webgpu | 60.98     |                        |
| cpu    | **38.93** | fastest                |

CPU wins by ~1.6× at BOTH configurations. So `candidateDevices()` leads with
`cpu` on darwin — a measured order, not the accelerator-first default —
while keeping `webgpu` and `coreml` in the list so a future model, a fixed
CoreML, or different hardware can still win. win32/linux keep an
accelerator-first order and are EXPLICITLY unmeasured: no such hardware here.
`server/ml/worker/devices.test.js` pins the darwin order so it cannot be
"corrected" back on principle without re-running the benchmark.

Implied backfill cost at 114k photos: 114,000 × 38.93 ms ≈ **74 minutes** of
pure inference, idle-gated.

### The most valuable finding of the run

**CoreML constructs a session cleanly and then throws on first real inference,
and the failure is BATCH-SIZE SENSITIVE** — fine at batch=1, broken at
batch ≥ 2. Production batches are 16.

So the obvious validation (load the model, embed one image, accept the EP)
would have blessed CoreML, reported `describeProvider() -> "coreml"` to the
user, and then failed EVERY production batch — at which point the sweep's
permanent classification would have written a sentinel for every photo in the
library. That is the deleted renderer host's Critical 1, relocated one layer
down and reached by a different route.

Two things came out of it, and both are load-bearing:

- `loadWithBestDevice()` validates each candidate with the REAL request's own
  images at its REAL batch size, once per cold load.
- `runSweep` no longer treats a host-level failure as the photo's fault at all:
  `embedSweep` passes an `isTransient` hook that classifies anything the
  encoder rejects with as a PAUSE, not a sentinel (#161 final review, Critical
  1), and `POST /api/ml/retry-failed` can take back a sentinel that was
  written for any reason at all.

### Smaller corrections to the text above

- **§C's `WebGpuMLService`** does not exist. `MLService` has one real
  implementation, `OnnxMLService`.
- **"Dev mode: silent fallback to the ONNX child"** — there is nothing to fall
  back from; the ONNX child is the only host, in dev and in the packaged app
  alike.
- **RAW is not embeddable** and is excluded from the worklist and the counts
  (`server/db/embeddings.js`). The spec's input pipeline assumed a 320px thumb
  exists for every photo; `processing.thumbnail()` throws
  `RawDecodeUnavailableError` for RAW by design, so attempting one would give
  every RAW file a permanent failure record.
- **Embedding is OPT-IN, off by default** (John's ruling during Task 10). The
  spec's own "first use shows what is being fetched, how big, and its licence"
  is unimplementable if a scan can start a 94 MB download unasked.
- **`ORT version: try overrides to 1.27`** — done, and it worked; both
  duplicated native addons (`onnxruntime-node` AND `sharp`, which the spec
  missed) are collapsed to one copy each. The `overrides` shape matters: see
  `_overridesNotes` in `package.json` for the adm-zip landmine a sibling
  top-level key silently re-opens.
