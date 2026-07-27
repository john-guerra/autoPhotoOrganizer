# AutoGallery v2 — status & roadmap

> **⚠️ For CURRENT status, read `CHANGELOG.md` (newest first) and the open
> [GitHub Issues](https://github.com/john-guerra/autoPhotoOrganizer/issues), not
> this file.** The app is a stable `2.17.x` release; the "Where the project is"
> log below is **prototype history (v0.1–v0.2)**, kept for context, not a current
> snapshot. What stays evergreen here is the **Working agreements** section — read
> that. (Freshness noted 2026-07-24; see `docs/AI-CODING-REVIEW-2026-07-24.md`
> Rec 2.)

_This file is a handoff document: read it together with `CLAUDE.md` and
`docs/superpowers/specs/2026-07-06-photo-triage-design.md` for full context._

## Where the project was — prototype history (v0.1–v0.2)

_Historical build log; current status lives in `CHANGELOG.md` + GitHub Issues._

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
  isn't ready within one tick on the _first_ scan of a session — only on
  rescans. Design doc:
  `docs/superpowers/specs/2026-07-06-post-scan-focus-fix-design.md`.

**Electron packaging + native folder picker (done, merged `1841458`, closes
issues #7 and #32)** —

- The app is now also a packageable Electron desktop app (Mac/Windows/
  Linux), not just a browser dev server — `electron/main.js` (ES modules)
  wraps the existing Express server unchanged and opens a `BrowserWindow`;
  `electron/preload.cjs` stays CommonJS (confirmed necessary: Electron's
  sandboxed preload loader cannot load ESM). Security model:
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  exposing exactly one `contextBridge` method (`pickFolder`) — deliberately
  not repeating `legacy/2024-electron-standalone/main.js`'s insecure
  pattern.
- Closes #7 (folder selector UI): the raw path `<input>` is replaced by a
  "Choose Folder…" button (visible only inside Electron, feature-detected)
  that opens a real native `dialog.showOpenDialog`.
- `server/library.js`: a persisted "library" of previously-scanned folders
  (`~/.autogallery/library.json`), same pattern as `ratings.json`/
  `coverChoices.json`; `GET /api/library` reports each entry's mounted/
  offline status (`fs.existsSync`) for the removable-drive (SD card) case.
  Shown as a dropdown in the topbar in both Electron and plain-browser dev
  mode.
- `electron-builder` packaging config (dmg/zip + nsis + AppImage across all
  three OSes; `directories.output: "release"` to avoid colliding with
  Vite's `dist/` build output; `asarUnpack` for sharp's native binaries)
  and a tag-triggered GitHub Actions release workflow
  (`.github/workflows/release.yml`, matrix build across all three OSes).
  `electron-updater` checks GitHub Releases for updates in production only.
- Not yet done: actually cutting a signed release (needs an Apple Developer
  Program membership for notarization and a Windows code-signing
  certificate — account/billing decisions, not technical blockers).
  Design doc: `docs/superpowers/specs/2026-07-06-electron-packaging-design.md`.
  Plan: `docs/superpowers/plans/2026-07-06-electron-packaging.md`.

## Backlog

Tracked in GitHub Issues (milestones `v0.2`, `Backlog (unprioritized)`,
`Phase 3`): https://github.com/john-guerra/autoPhotoOrganizer/issues —
this replaced the flat markdown backlog list that used to live here, since
it was straining to track priority/status as it grew. Design docs and
implementation plans stay in this repo under `docs/superpowers/`; day-to-day
backlog triage happens on GitHub.

## Working agreements (how John wants the work done)

- **John verifies visually himself** at `localhost:5173` while the dev
  server hot-reloads. Automated browser verification (claude-in-chrome/
  Playwright) is fine when it's actually useful, but use it in moderation —
  it burns tokens — and prefer unit tests first. Don't reach for a full
  browser session for things a unit test already covers.
- **Test photo folders — STRICTLY READ-ONLY, handle with extreme care**
  (never write/move/rename/delete inside them; all app writes go to
  `~/.autogallery/` only). Real paths are personal and not committed — see
  `docs/TEST_FOLDERS.local.md` (gitignored).
- **Challenge him with evidence** — he explicitly asked not to be agreed
  with by default.
- **`testing` is the trunk; `main` is the release line.** Branch every issue
  off `origin/testing` and target `testing` with the PR. John validates a
  batch there, then merges `testing` → `main` and tags `v*`, which is what
  `release.yml` builds. Never merge to `main` or cut a `v*` tag yourself —
  both are his call, for the same reason he closes issues himself. (This
  replaced the old `v2-reorg` push target.)
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
