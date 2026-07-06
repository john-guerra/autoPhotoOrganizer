# AutoGallery v2 — agent guide

Fast, local-first photo triage. Plug in an SD card → instant grid → keyboard-fast
culling → best photos organized into dated album folders. Built for a photographer
who returns from trips with thousands of JPEGs/videos (occasional RAW) and finds
Lightroom too slow.

## Two invariants (do not violate)

1. **Folders on disk are the source of truth.** There is never an owning catalog.
   The app reads and writes real folders; users can move files with Finder and the
   app catches up on rescan.
2. **The SQLite index is a rebuildable, persistent cache on the INTERNAL disk**
   (`~/.autogallery/`), keyed by content hash and tracking the source volume per
   folder. It is a speed layer AND an offline mirror: with the external drive
   unmounted, previews/metadata/ratings still browse from cache (Lightroom
   smart-previews style, with an "offline" badge). Ratings live in SQLite so
   rating works offline; only export/moves/resizes require the drive mounted.

## Performance thesis

- **Never fully decode a RAW during culling.** Extract the camera's embedded JPEG
  preview (RAW) or the EXIF/embedded preview (JPEG) via exiftool daemon mode.
- **Incremental rescans** key on path + mtime + size; unchanged files are skipped.
- **Grid appears while scanning continues** (progressive render).
- **Loupe keeps a ±N decoded prefetch window** so back/forth navigation is instant.

## Architecture

- **Backend: Node.js.** All decode/extract/measure work sits behind the
  `ProcessingService` interface (`server/processing/`) so engines can be swapped
  (Node native → WASM → Python ML sidecar) without touching scanner/index/UI.
  MVP engine uses exiftool-vendored (daemon), sharp/libvips, ffmpeg.
- **Frontend: Svelte + d3 (Vite).** Virtualized grid, loupe, keyboard-first stars
  1–5 (single keystroke + auto-advance), d3 timeline for album boundaries.
- **Album clustering** is a pure, framework-free module (`server/albums/`) ported
  from the legacy time-gap algorithm.

## Commands

- `npm run dev` — Express API (`:4321`) + Vite UI (`:5173`) concurrently.
- `npm test` — vitest run.
- `npm run build` — Vite build to repo-root `dist/` (served by Express in prod).
- `npm run format` — prettier.

## Repo map

- `server/` — Express API + `ProcessingService` + `albums/` clustering.
- `ui/` — Vite + Svelte frontend (config in `ui/vite.config.js`, `vite ui`).
- `docs/superpowers/specs/` — design docs. Start with
  `2026-07-06-photo-triage-design.md`.
- `legacy/` — **do-not-run** reference only (two prior generations; known insecure
  patterns). Read it to port the album-clustering algorithm; never execute it.

## Conventions

- **ESM** everywhere (`"type": "module"`).
- **No TypeScript** for now — plain JS with JSDoc types. Revisit only if decided
  explicitly later.
- **Tests: vitest**, colocated as `*.test.js` next to sources under `server/`.
- **Prettier** for formatting.
- **Svelte + d3** on the frontend.
- Every file-serving endpoint MUST route user paths through
  `server/lib/safeResolve.js` (path-traversal guard — the legacy app was flagged).
