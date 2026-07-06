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

**Grid virtualization (done, commits `d7dbff4`, `e23f3b6`, `7db9334`)** —

- `ui/src/lib/layouts/windowing.js`: pure `visibleRange(boxes, viewport)`,
  binary-searches the justified layout's y-sorted boxes for the indices
  intersecting the current scroll viewport + overscan.
- `ui/src/App.svelte` renders only that window, force-including the
  selected index so keyboard jumps (Home/End, arrow past the window)
  still mount their target and trigger `Thumb`'s existing `scrollIntoView`.
  DOM node count now stays roughly flat regardless of folder size.
- Design doc: `docs/superpowers/specs/2026-07-06-grid-virtualization-design.md`.

**Post-scan focus fix (done, commits `9b96931`, `cacec04`, closes issue #1)** —

- Focus now moves to the selected photo after a successful scan, so Enter
  opens the loupe instead of re-triggering a scan.
- Deferred via a `focusPending` flag consumed once `boxes` is truthy,
  rather than a fixed `tick()`: Svelte's `bind:clientWidth` resolves its
  initial value asynchronously (iframe `onload`), so the grid's layout
  isn't ready within one tick on the *first* scan of a session — only on
  rescans. Design doc:
  `docs/superpowers/specs/2026-07-06-post-scan-focus-fix-design.md`.

## Backlog

Tracked in GitHub Issues (milestones `v0.2`, `Backlog (unprioritized)`,
`Phase 3`): https://github.com/john-guerra/autoPhotoOrganizer/issues —
this replaced the flat markdown backlog list that used to live here, since
it was straining to track priority/status as it grew. Design docs and
implementation plans stay in this repo under `docs/superpowers/`; day-to-day
backlog triage happens on GitHub.

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
