# Loupe details panel (#27) + neighbor filmstrip (#28)

Status: approved design, ready for implementation planning
Date: 2026-07-10
Issues: #27 (details panel), #28 (filmstrip)

## Goal

Round out the Loupe (detail view) so per-photo triage matches the grid work:

- **#27** — a right-hand details panel showing filename, folder, dimensions,
  file size, capture/created dates, camera, **full EXIF (lens, aperture,
  shutter, ISO, focal length)**, rating, and stack/keep state. Lightroom-style.
- **#28** — a horizontal filmstrip of neighbouring thumbnails along the bottom,
  in the current feed order, so the user can see context and jump between photos
  without leaving the Loupe.

Both are **toggleable and remembered**; together they replace the current
bottom HUD bar (its info moves into the details panel, freeing the bottom for
the filmstrip).

## Approved decisions

1. **Layout** — details panel on the right absorbs the current bottom HUD's
   content (filename, count, rating, select state); the whole bottom becomes the
   filmstrip.
2. **Content** — full EXIF now, which means extending the backend metadata
   extractor, not just surfacing already-fetched fields.
3. **Visibility** — both toggleable via keys (`I` = details, `F` = filmstrip),
   default on, persisted in `localStorage`.

## Architecture

### Component structure

Split the growing `Loupe.svelte` into three focused units:

- **`Loupe.svelte`** — layout shell: the image/video stage (unchanged), an
  optional right `LoupeDetails`, an optional bottom `LoupeFilmstrip`. Keeps the
  existing ±3 image prefetch. Owns the current photo's detail-meta fetch/cache
  and passes data down.
- **`LoupeDetails.svelte`** — presentational right panel. Input: the current
  photo's full meta object (+ rating/selection/stack state). No data fetching of
  its own; renders rows, showing `—` for any missing field.
- **`LoupeFilmstrip.svelte`** — bottom strip. Input: `items`, `index`; output:
  a `select` event with the chosen index. Owns its own horizontal scroll and
  windowing.

Rationale: each unit has one job and a narrow prop/event interface, is
understandable in isolation, and keeps `Loupe.svelte` from growing into a
god-component.

### Backend — EXIF extraction

- **Processing engine** (`server/processing/NodeProcessingService.js`,
  `metadata()`): extend the exiftool `pick` list from
  `["DateTimeOriginal", "CreateDate", "Make", "Model"]` to also include
  `FNumber`, `ExposureTime`, `ISO`, `FocalLength`, `LensModel`. Map them onto the
  returned meta object (`aperture`, `shutter`, `iso`, `focalLength`, `lens`).
  Videos (ffprobe path) leave these unset. Update the `ProcessingService`
  `metadata` typedef/JSDoc to document the new optional fields.
- **Schema** (`server/db/schema.js`): idempotent `ensureColumn` on `photos`:
  `aperture REAL`, `shutter REAL`, `iso INTEGER`, `focal_length REAL`,
  `lens TEXT`. Matches the existing `ensureColumn` migration style (no migration
  runner).
- **`/api/meta`** (`server/api.js`): on extraction, persist the new columns
  alongside the current `taken_at/width/height/camera/duration` update; return
  them in the response. The existing "needs extraction" trigger
  (`width === null || camera === null`) already covers first-time reads, so no
  new trigger logic is needed.

### Data flow — lazy, Loupe-scoped

The grid's `enrichMeta` stays lightweight (width/height/takenAt/duration only —
the grid does not need EXIF). The **Loupe** fetches full meta on demand:

- On `index` change, if the current photo's id is not in the Loupe's
  `detailMeta` (`id → meta`) Map, `fetchMeta([id])` and store it; also prefetch
  the immediate neighbours (`±1`) for snappy navigation.
- `/api/meta` persists on first read, so re-viewing a photo is instant and no
  repeat extraction happens.

This keeps EXIF cost entirely off the grid and scoped to what the user actually
inspects.

### Filmstrip behaviour

- Renders neighbouring thumbnails from `items` in order, current one highlighted
  and auto-scrolled to horizontal centre on `index` change.
- Click a thumb → emit `select` with that index (App two-way-binds `index`).
- **Windowed**: only render ±~40 entries around `index` (plain `<img>` with
  `thumbUrl`, not the full grid `Thumb` component) so a 10k-photo feed never
  mounts thousands of images. The window recentres as `index` moves.
- Collapsed-section placeholders (non-real entries in `items`) render as a thin
  gap, never a broken thumb.
- Video entries show the ▶ badge; selected photos show a small ✓ marker.

### Keyboard + persistence

- `I` toggles the details panel, `F` toggles the filmstrip — added to
  App.svelte's existing Loupe key handling block (where arrow-key navigation
  already lives).
- State in `localStorage`: `autogallery.loupeDetails`, `autogallery.loupeFilmstrip`
  (default on, matching the existing `autogallery.*` `$:` persistence pattern),
  passed to `Loupe` as props.
- Both shortcuts added to the `?` shortcuts overlay (`ShortcutsOverlay.svelte`).

### Error handling / edge cases

- **Missing EXIF** (RAW without embedded EXIF, edited/stripped files, videos):
  the panel shows `—` for absent fields; whole EXIF block is hidden if none are
  present. Videos show dimensions/duration and hide camera-EXIF rows.
- **Placeholder at `index`**: the existing `isRealPhoto` guard already blanks the
  stage; the details panel shows nothing and the filmstrip highlights nothing.
- **Meta fetch failure**: metadata is an enhancement — the panel degrades to the
  fields already on the item (name, dimensions, dates, rating); no error dialog.

## Testing

- **Unit (vitest):**
  - EXIF field mapping in the processing engine (exiftool fields → meta object),
    following existing `NodeProcessingService` metadata tests.
  - Pure format helpers: `ƒ/2.8`, `1/250 s` (and `0.5 s` for long exposures),
    `ISO 400`, `50 mm`, dimension/size formatting — colocated `*.test.js`.
  - `/api/meta` persists and returns the new columns; schema `ensureColumn`
    idempotency.
- **Live browser verification** for the panel/filmstrip UI (no Svelte
  component-test harness — per project convention in CLAUDE.md/ROADMAP):
  toggling with `I`/`F`, filmstrip click-to-jump and auto-centre, and the
  RAW/video/EXIF-stripped fallbacks.

## Scope / YAGNI

**In:** the fields in the approved mockup — camera, lens, aperture, shutter,
ISO, focal length, dimensions, file size, capture/created dates, rating, kind,
video duration, stack/keep state; toggle + persistence; windowed filmstrip.

**Out (deferred, each its own issue if wanted):** GPS/map, histogram, editable
metadata, per-field copy-to-clipboard, drag-to-resize panel, RAW full-EXIF
beyond the listed fields.

## Versioning

Per CLAUDE.md: patch bumps during implementation (feature work is patch under
the current convention); `CHANGELOG.md` updated in the same commits. A packaged
build later cuts the next minor.
