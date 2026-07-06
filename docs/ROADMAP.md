# AutoGallery v2 — status & roadmap

_Last updated: 2026-07-06. This file is the handoff document: read it together
with `CLAUDE.md` and `docs/superpowers/specs/2026-07-06-photo-triage-design.md`
to continue the work with full context._

## Where the project is

**Stage 0 (done)** — repo reorganized: legacy apps archived under `legacy/`
(read-only reference; the `legacy-snapshot` git tag preserves the pre-reorg
state), `node_modules` untracked, v2 scaffold at root, design doc written.

**Prototype v0.1 (done, commit `1460bbd`)** — the first usable culling slice:

- `POST /api/scan` — non-recursive folder scan, images only
  (jpg/jpeg/png/webp/gif), numeric-id sessions (UI never sends raw paths).
  Measured: **10,172 photos in ~110–190 ms**.
- `GET /api/thumb/:id?size=` — sharp thumbnails, disk cache in
  `~/.autogallery/cache/thumbs` keyed by sha1(absPath+mtime+size). Cold
  ~25–35 ms, cached ~2 ms. `GET /api/image/:id` streams originals.
- Ratings: keys `1`–`5` (`0` clears) in grid and loupe, auto-advance in
  loupe; persisted to `~/.autogallery/ratings.json` keyed by **absolute
  path** so they survive rescans.
- Loupe: ←/→ with ±3 prefetch, Esc back to grid.

**Justified gallery (done, commit `a77e2e5`)** —

- `ui/src/lib/layouts/justified.js`: Flickr's justified algorithm as a
  **pure function** (`items{id, aspectRatio} → boxes{id,x,y,width,height}`),
  unit-tested. This is the layout contract: future layouts (treemap,
  timeline, embedding scatter) and renderers (WebGL) implement the same
  interface — see the "Rendering strategy" section of the design doc.
- `server/metaCache.js`: persistent dimensions/date cache
  (`~/.autogallery/metacache.json`, keyed absPath+mtime; EXIF orientation
  normalized). 10k folder: ~0.87 s per 500 photos once, then ~1.7 ms.
- Density: 5 zoom levels (120–400 px row height), `+`/`-` keys + slider,
  persisted; thumbnails re-fetch at DPR-aware size buckets
  (160/320/480/640/1024).

## v0.2 backlog (next, in recommended order)

1. **Grid virtualization** — all 10k thumbnails currently exist as DOM
   nodes (images lazy-load, but scroll will strain at scale; "millions"
   is the ambition). Virtualize using the justified layout's computed
   boxes (absolute positioning makes windowing straightforward).
2. **Post-scan focus fix** — after Scan, focus stays in the path input, so
   Enter re-scans instead of opening the loupe. Move focus to the grid.
3. **Burst stacks** — group near-duplicate shots; pick the winner within a
   stack. On Pixel photos this is EXACT via filenames
   (`PXL_..._BURST-01.COVER.jpg`, `BURST-02`, ...); fallback is time-gap
   proximity (shots < a few seconds apart). UI: stack collapses to its
   cover with a count badge; expand to compare side-by-side.
4. **Album clustering port** — port the time-gap algorithm from
   `legacy/2024-electron-standalone/autoAlbums.js` (mean + stddev of
   inter-photo intervals, custom separation overrides, filename-date
   fallback) into `server/albums/` as a pure tested module. d3 timeline
   with interactive separation threshold in the UI. **John authors/tunes
   the thresholds and the burst-stack heuristic — his domain expertise.**
5. **Video support** — 809 MP4s in the test folder are currently skipped.
   ffmpeg (ffmpeg-static) frame-grab thumbnails via `ProcessingService`.
6. **Export** — rating ≥ N → copy into `_selected/` (optional `_peq`
   resized variant), never destructive. This materializes ratings to disk
   (folders are truth) and creates the labeled data for later ML.

Then: SQLite index (better-sqlite3) replacing the JSON caches, incremental
rescan, ingest-from-SD-card flow, RAW embedded-preview extraction
(exiftool-vendored). Phase 2+: faces/CLIP local search, predict-my-picks,
WebGL zoomable archive view (see design doc).

## Working agreements (how John wants the work done)

- **John verifies visually himself** at `localhost:5173` while the dev
  server hot-reloads. Do NOT run automated browser/Playwright verification
  unless he explicitly asks — it burns tokens. Run unit tests, then stop
  and report tersely.
- **Test photo folders — STRICTLY READ-ONLY, handle with extreme care**
  (never write/move/rename/delete inside them; all app writes go to
  `~/.autogallery/` only):
  - `/Users/aguerra/Pictures/fotos_bk/2025_10Oct_30_Backup_cell_pixel9pro/DCIM/Camera`
    — 10,172 JPGs + 809 MP4s, the scale test (~800 hash-named files: don't
    assume `PXL_` naming).
  - `/Users/aguerra/Pictures/fotos/Wonders Years` — 198 JPEGs, small demo set.
- **Challenge him with evidence** — he explicitly asked not to be agreed
  with by default.
- Direct pushes to `master` may be blocked by tooling; push to the
  `v2-reorg` branch (John merges/fast-forwards `master` himself).
- Commit early; the working tree should not accumulate multi-feature
  batches (an interrupted session nearly stranded uncommitted work once).

## Key decisions already made (do not relitigate without new evidence)

Recorded in full in the design doc: folders are truth; persistent-but-
rebuildable index on the internal disk doubling as an offline mirror
(browse + rate with the external drive unmounted); stars 1–5; Node backend
with `ProcessingService` port (native now, WASM/Python-sidecar possible
later); Svelte + d3 frontend; no TypeScript; layouts are pure functions;
DOM-virtualized rendering for culling, GPU/atlas pipeline deferred to the
archive-zoom phase; ML (faces, CLIP search, pick prediction) all local,
all JS, Phase 2.
