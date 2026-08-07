# AutoGallery v2 — Design

Status: Draft / scaffold stage
Date: 2026-07-06

## Context & problem

John (infovis PhD, d3 expert) returns from trips with thousands of photos — mostly
JPEG plus video, with the occasional RAW. He wants a tool that lets him: plug in an
SD card, get an instant grid, cull fast with the keyboard, and organize the keepers
into dated album folders. Lightroom is too slow for this triage loop and Picasa is
dead.

His archive already lives on an external drive with established folder conventions:

- `YYYY_MMMon_DD_Name` album folders (e.g. `2015_12Dic_27_La_Pastora`).
- `_selected` subfolders / variants for chosen photos.
- `_peq` (resized) variants for smaller copies.

AutoGallery v2 must respect and produce these conventions, and must be fast enough
that culling never stalls.

## Architecture decisions

| Decision              | Choice                                                                                                                                                          | Rationale                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source of truth       | **Folders on disk.** Never an owning catalog.                                                                                                                   | Files stay portable; Finder moves are fine; nothing to corrupt or lock users into.                                                                                                 |
| Speed + offline layer | **SQLite index (better-sqlite3) + thumbnail/preview cache on the INTERNAL disk** (`~/.autogallery/`), keyed by content hash, tracking source volume per folder. | Rebuildable from folders, but persistent. With the external drive unmounted, the app still browses previews/metadata from cache (Lightroom smart-previews style, "offline" badge). |
| Ratings               | Stored in **SQLite** (stars 1–5).                                                                                                                               | Rating works offline; the drive is only needed for export/moves/resizes.                                                                                                           |
| RAW handling          | **Never fully decode a RAW during culling.** Extract the camera's embedded JPEG preview.                                                                        | Cameras embed a full-size JPEG preview in RAW; JPEGs carry EXIF thumbnails. Decoding RAW is the slow path Lightroom pays; we skip it.                                              |
| Scanning              | **Incremental rescan by path + mtime + size**; grid renders while scanning continues.                                                                           | Rescans are cheap; first pixels are fast.                                                                                                                                          |
| Loupe                 | Keep a **±N decoded prefetch window**.                                                                                                                          | Back/forth navigation feels instant.                                                                                                                                               |
| Backend               | **Node.js**, all processing behind a `ProcessingService` interface.                                                                                             | One seam to swap engines (native → WASM → Python ML) without touching scanner/index/UI.                                                                                            |
| Frontend              | **Svelte + d3 (Vite).**                                                                                                                                         | Virtualized grid + loupe; d3 for the album-boundary timeline; keyboard-first.                                                                                                      |
| Rating model          | **Stars 1–5, keys 0–5, auto-advance.**                                                                                                                          | Single keystroke per photo keeps the cull loop fast.                                                                                                                               |
| Language              | **Plain JS + JSDoc, ESM.** No TypeScript yet.                                                                                                                   | Keep friction low; revisit explicitly later.                                                                                                                                       |

## Components

- **Scanner** — walks a folder, classifies files (image / raw / video) by
  extension, and produces file records keyed by path + mtime + size for
  incremental rescans. Feeds the index and the grid progressively.
- **Index** — SQLite (better-sqlite3) on the internal disk at `~/.autogallery/`.
  Stores file records, extracted metadata, ratings, and a content-hash-keyed
  pointer to cached thumbnails/previews. Tracks the source volume per folder so the
  app knows what is "offline". Fully rebuildable from folders.
- **ProcessingService** (`server/processing/`) — the interface behind which all
  decode/extract/measure work lives (`scan`, `extractPreview`, `thumbnail`,
  `videoThumb`, `metadata`). `NodeProcessingService` is the MVP implementation
  (exiftool-vendored daemon, sharp/libvips, ffmpeg). Future adapters: WASM for
  browser/mobile, Python sidecar for ML.
- **Album clustering** (`server/albums/`) — a pure, framework-free port of the
  legacy time-gap algorithm (see below). No Express, no DOM: trivially testable.
- **Cull UI** (`ui/`) — virtualized grid, loupe with prefetch window,
  keyboard-first star rating, burst stacks, and a d3 timeline visualizing album
  boundaries.
- **Export** — copies/moves photos rated ≥ N into `_selected` folders, optionally
  producing `_peq` resized variants. Requires the drive mounted.

## Performance strategy (the core thesis)

1. **Never decode RAWs during culling.** Extract embedded JPEG previews via
   exiftool daemon mode — full-size for RAW, EXIF thumbnail/embedded preview for
   JPEG.
2. **Incremental rescans** on path + mtime + size; skip unchanged files.
3. **Progressive render** — the grid appears while scanning continues in the
   background.
4. **Loupe prefetch** — keep ±N decoded neighbours in memory so navigation never
   waits on a decode.
5. **Batch EXIF** through the exiftool daemon rather than spawning per file.

## Album clustering algorithm (to port)

Ported from `legacy/2024-electron-standalone/autoAlbums.js` into a pure module:

- Sort photos by capture date.
- Compute the list of inter-photo intervals (separations).
- Compute the **mean** and **standard deviation** of those intervals.
- Default split threshold ≈ `mean + k · stddev` (legacy used ~2·stddev); split a
  new album wherever an interval exceeds the threshold.
- Support **custom separation overrides** (user sets the gap manually).
- **Filename-date fallback**: parse `YYYY(-)MM(-)DD` from the filename when EXIF is
  missing; fall back to file mtime after that.
- Name albums using the `YYYY_MMMon_DD_Name` convention.

> The exact clustering thresholds and the burst-stack heuristic will be authored
> and tuned by John — this is his domain expertise (infovis + years of his own
> archive). The code should make these parameters easy to expose and adjust, not
> bake in magic numbers.

## MVP scope

- **Ingest** (optional): copy SD card → dated album folders via time-gap
  clustering.
- **Cull**: grid + loupe + stars (1–5, auto-advance) + burst stacks.
- **Export**: rating ≥ N → `_selected`, optional `_peq` resize.

You can cull ANY folder from day one; ingest is an optional first step.

### Out of MVP

Faces, ML ranking, cloud/mobile, and any photo editing.

## Phase 2 (recorded 2026-07-06 — the first bullet has since SHIPPED)

> **Status note, 2026-08-07 (#336).** This section is kept as written, because
> a spec records what was decided and when. But the heading used to say
> "recorded, not built" and that is no longer true of half of it, which is the
> kind of quietly-stale claim #323 was filed about. As of 2.21.0:
>
> - **Local search — SHIPPED.** Face detection and grouping, the People view,
>   the Face Map, and on-device SigLIP/CLIP embeddings with near-duplicate
>   detection. Exactly the stack named below: transformers.js / ONNX Runtime in
>   Node, computed in the background, stored in the SQLite index.
> - **"Predict my picks" — still not built.** So is the GPU archive renderer
>   under "Rendering strategy" below.

- **Google-Photos-style local search** — face detection/clustering + CLIP
  embeddings via transformers.js / ONNX Runtime in Node. All local, all JS,
  computed lazily in the background, stored in the SQLite index.
- **"Predict my picks" ML** — finished trips are labeled training data
  (`_selected` vs not), so the app can learn to pre-rank likely keepers.

## Rendering strategy (decided 2026-07-06)

Two rendering tiers, one layout contract:

- **Now (culling): virtualized DOM.** A virtualized grid handles the
  10k–100k linear-scroll case; DOM keeps free image decoding, native
  scrolling, focus, and accessibility. Millions of photos on screen is not
  a culling problem.
- **Phase 2+ (archive exploration): GPU canvas** (regl / pixi.js /
  deck.gl — chosen when built) for continuous semantic zoom over the whole
  archive (PhotoMesa-style zoomable walls, timelines, embedding scatters).
  The hard part is not the GL wrapper but **texture streaming**: the server
  grows a texture-atlas endpoint (micro-thumbs packed ~4,096 per 4096²
  sheet via sharp composite; ~250 atlases per million photos) plus an LOD
  pyramid (micro-thumb → thumbnail → preview) streamed by visibility.
- **The contract that keeps both cheap: layouts are pure functions** —
  `layout(items{id, aspectRatio}, viewport) → [{id, x, y, w, h}]`, no DOM,
  no Svelte, no GL (first implementation: `ui/src/lib/layouts/justified.js`).
  Future layouts (quantum treemap, zoomable timeline, CLIP-embedding
  scatter) and future renderers plug into the same interface.

## Planned MVP dependencies

Not installed in the scaffold — added during the MVP build:

- **exiftool-vendored** — EXIF read + embedded preview/thumbnail extraction
  (daemon mode).
- **sharp** (libvips) — fast thumbnail generation.
- **better-sqlite3** — the synchronous SQLite index.
- **ffmpeg-static** — video poster-frame thumbnails.

## Current scaffold dependencies

express (API), vite + svelte + @sveltejs/vite-plugin-svelte (UI), vitest (tests),
concurrently + prettier (dev tooling).
