# Fast SD-card thumbnails via two-tier progressive loading — Design

Status: Approved, ready for implementation plan
Date: 2026-07-06

## Context & problem

Live-testing against a real SD card (GitHub issue #33) surfaced that the
first-thumbnail-per-photo experience is much slower than the local demo
fixtures suggested. `NodeProcessingService.thumbnail(file, size)` does a full
sharp decode of the source file for every request, before anything is
cached — for slow, random-access removable media, that means a full-file
read over a slow bus plus a full JPEG decode for every image in the scan,
before the grid can paint anything. `extractPreview()` (the embedded-preview
path this project's own stated performance thesis in `CLAUDE.md` calls for —
"Never fully decode a RAW during culling. Extract the camera's embedded JPEG
preview... via exiftool daemon mode") is still an unimplemented stub, and was
never wired up even for the JPEG case. This contradicts the app's own "plug
in an SD card → instant grid" pitch.

A design direction — two-tier progressive loading — was already brainstormed
and agreed with the user in a prior session, but paused mid-write-up to
address the larger feed/tree-sidebar redesign first (issue #16 and the
persistent-index work). This spec formalizes that decision, revises one part
of it (the extraction mechanism), and extends its scope slightly (RAW file
discovery).

## Goal

1. Every grid tile shows the camera's embedded EXIF/JPEG preview instantly
   as a low-res "blur-up" placeholder — a few KB, read near the file
   header, avoiding a full decode of the multi-megabyte source over a slow
   SD-card bus — for every zoom level, then swaps in the real
   sharp-decoded thumbnail once it's ready in the background.
2. Extend file scanning to recognize common RAW extensions
   (`.cr2, .cr3, .nef, .arw, .dng, .orf, .rw2, .raf`) for the first time,
   using their embedded preview only — no full RAW decode. A RAW photo's
   grid thumbnail is its embedded preview, final, with no slow-tier
   upgrade attempted. Full RAW decoding (a real RAW decoder — dcraw/libraw
   or similar) is explicitly out of scope here and becomes its own future
   issue.
3. Preserve the existing offline-mirror invariant unchanged: only the
   full-decode tier's disk cache (`~/.autogallery/cache/thumbs/`) matters
   for browsing with the drive unmounted.

## Revised from the original brainstorm: extraction mechanism

The original brainstorm assumed wiring `exiftool-vendored` (a new
dependency, daemon-mode process) for embedded-preview extraction. This spec
uses `exifr` instead — already a project dependency (used today for
capture-date parsing in `metadata()`) — whose `thumbnail(path)` API extracts
the embedded EXIF/JPEG preview directly, for both JPEG and RAW containers,
with zero new dependencies and no daemon process to manage.

## API shape

`GET /api/thumb/:id?size=N` is unchanged — the existing full-decode route,
same cache key, same disk cache under `~/.autogallery/cache/thumbs/`.

A new `GET /api/preview/:id` serves the fast tier: looks up the photo,
calls `processing.extractPreview(path)`, and streams the returned bytes
back directly — no resizing (the browser scales it to fit the tile via
CSS, which is exactly the blurry "blur-up" look intended), no disk caching
(re-reading the embedded bytes on each request is cheap enough, and it only
ever matters once per photo — after the real thumbnail lands in the durable
cache, this route is never requested again for that photo). Returns 404 if
no embedded preview exists (some cameras/edited files strip it) — the
client simply never shows a placeholder for that tile, identical to
today's blank-then-fade behavior.

## Server implementation

`NodeProcessingService.extractPreview(file)` replaces its
`NotImplementedError` stub: calls `exifr.thumbnail(file)`, returns
`{ data, source: "embedded" }` (matching the existing `PreviewResult`
shape's `source` field, which already distinguishes `"decoded"` elsewhere).
Works identically for JPEG and RAW inputs — `exifr` reads an embedded
preview the same way regardless of container format, so no per-format
branching is needed here.

`IMAGE_EXTS` (in `NodeProcessingService.js`) gains the RAW extensions listed
in Goal #2, alongside the existing JPEG/PNG/WebP/GIF set — `scan()`
discovers RAW files for the first time as a direct consequence, with no
other change to the scan logic.

`thumbnail(file, size)` (the full-decode "slow tier") gains a guard: for a
RAW extension, it throws a new `RawDecodeUnavailableError` instead of
attempting a sharp decode that would fail anyway (sharp does not support
most RAW formats). The `/api/thumb/:id` route's existing try/catch already
surfaces a thumbnail failure as a controlled response — this spec doesn't
change that route's error handling, only ensures the thrown error is a
distinguishable, intentional signal rather than an opaque sharp decode
failure. The client-side consequence (no slow-tier upgrade attempted for
RAW, its embedded preview stays the final image) falls out of the existing
error-handling path in `Thumb.svelte` with no new client-side branching —
see below.

`metadata()`'s dimension-reading already falls back to the layout's
`DEFAULT_RATIO` when sharp can't read a file's dimensions (true for RAW
today), and its EXIF-date parsing already works for RAW via `exifr` with no
change needed.

## Client: `Thumb.svelte`'s two-tier swap

**Caught during spec self-review:** firing both requests unconditionally,
every time a tile mounts, would double server load even in the common case
where a folder was already fully scanned before and every full thumbnail is
a fast cache hit — the preview request would become pure overhead on every
subsequent visit, not just the first cold scan this feature exists to fix.

To avoid that, the preview request is delayed: a tile starts a short timer
(implementation-plan detail — on the order of ~150ms) when it becomes
visible, and only fires the `/api/preview/:id` request if the full
thumbnail hasn't already loaded by the time that timer fires. A warm cache
hit (already-scanned folder) resolves well under that delay today, so the
preview request never fires at all in that case — no added server load, no
visual change, since the full thumbnail was already fast. A cold, uncached
scan (this feature's actual target) takes meaningfully longer than the
delay, so the preview request fires and the blur-up placeholder appears as
intended.

Both `<img>` elements render stacked in the same box (preview behind, full
thumbnail in front, absolutely positioned to overlap); the full thumbnail
cross-fades in on load exactly like today's existing fade-in transition,
just with the low-res preview visible underneath while waiting instead of a
blank tile.

If the preview 404s, it simply never renders (no error state, no retry
affordance — the tile just waits for the full thumbnail with a blank
background, identical to today). If the full-thumbnail request fails (the
RAW `RawDecodeUnavailableError` case, surfaced as the route's existing error
response), the preview stays visible as the final image — no stall
countdown, no retry button, since there's nothing to retry: the embedded
preview _is_ the thumbnail for that file. This requires `Thumb.svelte` to
distinguish "RAW, no slow tier available" from a genuine transient failure
(network hiccup, corrupted file) so it doesn't show a misleading retry
button for a file that will never succeed at the full-decode tier — the
exact error signal for this distinction is an implementation-plan detail,
not pinned down further here.

## Testing

- `server/processing/NodeProcessingService.test.js`: `extractPreview`
  returns embedded bytes for a fixture with a real embedded thumbnail,
  returns `undefined`/throws cleanly when none exists (mirroring how
  `exifr.thumbnail()` itself behaves — resolved during implementation, not
  pinned down further here); `thumbnail()` throws
  `RawDecodeUnavailableError` for a RAW extension without attempting a
  sharp decode; `scan()`'s existing test gains RAW extensions to its
  recognized-files fixture list.
- `server/api.test.js`: new cases for `GET /api/preview/:id` — 200 with
  bytes for a fixture with an embedded preview, 404 when none exists, 404
  for an unknown id (matching `/api/thumb/:id`'s existing pattern).
- No new automated tests for `Thumb.svelte` — matches this project's
  established convention (manual-only verification for Svelte components,
  per `docs/ROADMAP.md`'s working agreement) — verified live against real
  SD-card-sourced test data instead.

## Out of scope

- Full RAW decoding (a real RAW decoder for the full-resolution/Loupe
  view) — a RAW photo's only available image throughout this app remains
  its embedded preview until a future issue takes this on.
- Video and HEIC support — already explicitly out of scope elsewhere in
  this codebase (`NodeProcessingService`'s own module doc).
- Re-extracting or re-requesting the preview after the full thumbnail is
  cached — once real is cached, `/api/preview` is simply never requested
  again for that photo/size combination; no explicit "don't ask again"
  bookkeeping is needed beyond the client only requesting it once per tile
  mount, same as the existing full-thumbnail request pattern.
- Changing the full-decode tier's existing cache key, cache location, or
  cache-hit/miss behavior — entirely unchanged by this spec.

## Validation

After implementation, exercise against real SD-card-sourced test data (per
`docs/TEST_FOLDERS.local.md`'s working agreement, read-only) — confirm the
grid paints near-instantly with low-res placeholders on a fresh scan (no
cache), confirm each tile smoothly upgrades to its real thumbnail shortly
after, confirm a RAW file (if present in test data) shows its embedded
preview with no broken-image/stall/retry UI, and confirm re-visiting an
already-cached folder shows real thumbnails immediately with no visible
blur-up flash (since the full-decode cache already has them, the preview
request either isn't needed or resolves to the same visual instantly).
