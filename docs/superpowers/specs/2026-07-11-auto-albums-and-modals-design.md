# Auto Albums polish + native-`<dialog>` modal foundation

**Date:** 2026-07-11
**Status:** Revised (Revision 1 below supersedes conflicting parts of the
original body) — Phase 1 in build.
**Related:** builds on `2026-07-10-albums-editable-names-inplace-design.md` and
`2026-07-09-fisheye-snapshot-view-design.md`.

> **Revision 1 (2026-07-11, after mid-build user feedback + an architect
> review) is at the bottom of this file and GOVERNS where it conflicts with the
> original body** (notably: the original "no backend changes" claim is wrong;
> materialize gets async-fs + dest defaults + auto-rescan; the standalone
> AlbumsView is now interim, superseded by a Phase-2 in-feed redesign).

## Problem

The auto-albums feature is the product's headline user story — _"I come back from
a trip with thousands of photos+videos; split them into per-day / per-event
groups and drop them into dated folders"_ — but it is under-explained and
under-configurable:

- The entry button just says **Albums** with a terse tooltip; a first-time user
  doesn't know what will happen.
- There is no up-front explanation of _how_ clustering works before it reorganizes
  the view.
- The only naming scheme is a fixed `YYYY-MM-DD`; the legacy tool had a
  configurable date-format + prefix + index, and the user's real-world convention
  nests a **year subfolder** (`2017/2017_01Jan_09_Diana_VR`).
- Typed album names are **lost** whenever the split slider re-clusters (they are
  re-seeded on any structural change).
- The default split threshold is the statistical `mean + k·stddev`, which is a
  good _auto_ mode but a poor _default_ to reason about; the user wants a concrete
  **1-minute** starting point with _Auto_ as an explicit button.

Separately, the app's modals are hand-rolled backdrop `<div>`s (`ManageLibrary`,
`ShortcutsOverlay`) with manual `z-index`, **no `Esc`, no focus trap, no focus
restoration**, and the `Library ▾` / add-folder dropdowns don't dismiss on
outside-click or `Esc` — they feel broken. The native `<dialog>` element now
provides all of this for free, so we standardize on it.

## Goals

1. Rename the entry to **Auto Albums** with a clear, friendly tooltip.
2. A **setup/explainer modal** (native `<dialog>`) that describes how clustering
   works and configures the split gap + folder-naming before previewing albums.
3. Default split gap **1 minute**, with an explicit **Auto** button for the
   statistical threshold.
4. A **strftime naming template** with live preview, token legend, and `/`
   support for nested (year) folders.
5. **Persist typed album names** across re-clustering, keyed to each album's first
   photo.
6. Persist naming/gap/move-copy **preferences** globally (`localStorage`).
7. Guarantee **videos** are included in albums (test).
8. A reusable **`Modal.svelte`** built on native `<dialog>`; retrofit
   `ManageLibrary` and `ShortcutsOverlay`; fix dropdown dismissal.

## Non-goals (deferred to their own GitHub issues)

- **AI-generated meaningful album names.** Keep the app free/offline; explore a
  local or opt-in path later. File an issue.
- **Change the capture date of a whole album** (fix a wrong camera clock by
  shifting every photo's timestamp). Common request, separate feature. File an
  issue.
- Per-folder work-in-progress persistence (remembering boundaries/names to SQLite
  across sessions). Explicitly out of scope — names persist only within a session.

## Implementation order

Per the user's request, **B (Auto Albums) first, then A (modal retrofits)**. The
reusable `Modal.svelte` is created in Phase B because `AlbumsSetupModal` needs it;
Phase A then applies that same component to the existing hand-rolled modals.

---

## Phase B — Auto Albums

### B1. Entry button — `ui/src/lib/ViewControls.svelte`

- Label `▤ Albums` → `▤ Auto Albums`; active state `✕ Auto Albums`.
- Tooltip: _"Group the photos you're viewing into albums by the pauses between
  shots — a long gap starts a new album. Preview, rename, then save them into
  folders (photos and videos)."_

### B2. Naming engine — `ui/src/lib/albums.js`

Add a pure, tested naming helper. **Reuse `d3.timeFormat`** (d3 is already a root
dependency) for the date tokens rather than hand-rolling strftime; handle the
non-date `%n` (album index) token ourselves.

```js
/**
 * Render an album folder name (which MAY contain "/" to nest folders) from a
 * strftime-style template. Date tokens are delegated to d3.timeFormat; %n is the
 * 1-based album index. Unknown %-codes pass through as d3 renders them.
 * @param {string} template e.g. "%Y/%Y_%m%b_%d"
 * @param {Date} date album start date
 * @param {number} n 1-based album index
 * @returns {string}
 */
export function renderAlbumName(template, date, n) { … }
```

- Supported date tokens (via d3.timeFormat): `%Y %y %m %b %B %d %H %M %S %j` and
  literals; `%n` → index; `/` → path separator (nested folders).
- Sanitization: leading/trailing whitespace trimmed; leading `/` stripped so the
  name is always relative to the destination (the server's `safeResolve` already
  blocks `..` traversal, but strip `..` segments defensively here for a clean
  error rather than a rejected job). Empty result falls back to `Album {n}`.
- Keep `computeGapStats`, `autoThresholdMs`, `clusterByGap`. `defaultAlbumName`
  stays for back-compat but new code goes through `renderAlbumName`.

### B3. Preferences store — `ui/src/lib/albumPrefs.js` (new, small)

A tiny module that reads/writes the global Auto-Albums preferences in
`localStorage` under a single key `autogallery.albumPrefs`:

```js
{ template: "%Y-%m-%d", gapMode: "fixed" | "auto",
  fixedGapMs: 60000, k: 2, move: true }
```

- `loadAlbumPrefs()` → merged with defaults (default template `"%Y-%m-%d"` — a
  generic default; the user saves their own `%Y/%Y_%m%b_%d`).
- `saveAlbumPrefs(patch)` → shallow-merge + persist.
- Default `gapMode: "fixed"`, `fixedGapMs: 60000` (**1 minute**).

### B4. Setup modal — `ui/src/lib/AlbumsSetupModal.svelte` (new)

Built on `Modal.svelte` (Phase B0). Sections:

1. **How it works** — 2–3 friendly sentences plus a tiny inline SVG showing dots
   clustering, with a big gap starting a new group. Copy example:
   _"AutoGallery looks at when each photo and video was taken. When there's a long
   pause between shots, it starts a new album. Drag the split gap to make albums
   bigger or smaller, or let AutoGallery pick a gap automatically."_
2. **Split gap** — a slider + type-exact field (reusing the existing
   `parseDuration`/`fmtDur` helpers), showing the current gap; default **1 min**.
   An **`Auto`** button switches to the statistical `mean + k·stddev` threshold
   (sets `gapMode: "auto"`); moving the slider/typing switches back to `fixed`.
3. **Folder naming** — a `template` text field with **live preview** (rendered
   against a sample date, e.g. the first album's start, via `renderAlbumName`) and
   a compact clickable token legend (`%Y %m %b %B %d %H %M %n` + `/` for nesting).
   Show the preview as a full path: `<dest>/<rendered>`.
4. **Move / Copy** radios and **destination** (folder path + native picker when
   available) — same semantics as today, seeded from prefs/`defaultDest`.
5. Footer: **Preview albums** (persists prefs, closes modal, applies to the review
   view) and **Cancel**.

Emits `apply` (with the chosen settings) and `close`.

**Open policy:** the modal opens automatically the **first time Auto Albums is
entered in a session** (tracked by an in-memory flag, or when no `albumPrefs`
exist yet). On subsequent entries the review view opens directly with saved
prefs. The review bar exposes **`⚙ Options`** and **`ⓘ How it works`** buttons
that re-open the modal.

### B5. Review view — `ui/src/lib/AlbumsView.svelte`

- **Default threshold** comes from prefs: `fixed` → `fixedGapMs` (1 min), `auto` →
  `autoThresholdMs(stats, k)`. Replaces the current `k=2` auto default.
- Add an **`Auto`** button and keep the slider/type-exact control; wire `gapMode`
  through so the button and slider stay consistent (Auto = clear the manual
  override, slider/type = set it). This reuses the existing `manualThresholdMs`
  machinery — do not add a parallel state path.
- **Name persistence keyed to first-photo id.** Replace the current
  `sig`-based re-seed (which keys on `index:ids.length:startAt` and so drops typed
  names on any re-cluster) with:
  - `editedNames: Map<firstPhotoId, string>` — only names the user actually typed.
  - On every re-cluster, compute each album's display name as
    `editedNames.get(album.ids[0]) ?? renderAlbumName(template, new Date(album.startAt), index+1)`.
  - When the user edits an album's name field, store it in `editedNames` under
    that album's current first-photo id.
  - Result: a typed name survives slider moves **as long as the album still starts
    with the same first photo**; albums whose first photo changed re-derive from
    the template. (Requirement #5.)
- Per-album name field pre-filled from the computed name, freely editable (append
  `_Diana_VR`). Names still flow through `namedAlbums()`'s collision-dedup and the
  existing materialize job unchanged.
- Add the `⚙ Options` / `ⓘ How it works` buttons that re-open `AlbumsSetupModal`.

### B6. App wiring — `ui/src/App.svelte`

- On `detectAlbums`, decide whether to show the setup modal first (first entry /
  no prefs) vs. go straight to review.
- Pass prefs into `AlbumsView`; handle the modal's `apply` to update prefs +
  clustering.

### B7. Backend — no code change; add a test

Nested names already work: `resolveExportTarget` → `safeResolve` uses
`resolve()` (handles `a/b` subpaths, blocks `..`), and `copyIdsIntoFolder` does
`mkdirSync(target, { recursive: true })`. **No server change required.**

- Add a test in `server/db/feed.test.js` asserting a **video** row is returned by
  `workingSetTimeline` (so videos cluster into albums) — guards the user story.

---

## Phase A — Modal foundation & retrofit

### B0/A0. `ui/src/lib/Modal.svelte` (new; created in Phase B, used across both)

A thin reusable wrapper over the native `<dialog>` element, borrowing Bootstrap's
_structure/semantics_, not its CSS:

- Props: `open` (two-way `bind:open`), `title`, optional `size`
  (`sm|md|lg`), optional `dismissible` (default true).
- Uses `dialogEl.showModal()` when `open` becomes true, `dialogEl.close()` when
  false — driven by a reactive statement so `bind:open` works.
- Native behaviors relied upon: top-layer render (no `z-index`), `::backdrop`,
  `Esc` → `cancel` event → close, focus trapped in the dialog, focus **restored**
  to the invoker on close.
- Backdrop click closes (detect a click whose target is the `<dialog>` itself,
  i.e. outside the inner content wrapper). Content click never closes (no
  `stopPropagation` gymnastics — the inner wrapper simply isn't the dialog).
- Body scroll-lock while open.
- Accessibility: `aria-labelledby` pointing at the header; header/body/footer
  `<slot>`s; a default ✕ close button in the header.
- Emits `close`.

### A1. Retrofit `ManageLibrary.svelte`

Replace the hand-rolled `.manage-library-backdrop/.panel` with `<Modal>`; keep
all existing sections/logic. Gains Esc/focus-trap/restore and removes the manual
z-index + `stopPropagation`.

_(Note: the inner native `confirm()` calls are a separate concern — leave them for
now, or track as a follow-up; not in scope.)_

### A2. Retrofit `ShortcutsOverlay.svelte`

Same conversion onto `<Modal>`.

### A3. Dropdown dismissal — `ui/src/lib/SourceControls.svelte`

Make `Library ▾` and the add-folder popover dismiss on **outside-click** and
**`Esc`**. Prefer a small reusable Svelte action `clickOutside`/`onEscape` (in
`ui/src/lib/actions.js`) over ad-hoc listeners, so it's reusable. (The native
Popover API is an alternative but the action keeps the existing markup/logic.)

---

## Testing

- **`albums.test.js`**: `renderAlbumName` — date tokens, `%n`, nested `/`, empty
  fallback, leading-`/` and `..` sanitization.
- **`albumPrefs`**: load/merge/save round-trip with defaults (mock localStorage).
- **Name persistence** logic: given clusters with a stable vs. changed first
  photo, a typed name is kept vs. re-derived. (Unit-test the pure mapping helper;
  extract it from the component if needed.)
- **`feed.test.js`**: video included in `workingSetTimeline`.
- **Modal**: a light DOM test that `open` toggles `showModal`/`close` and `close`
  fires on Esc/backdrop (jsdom `<dialog>` support is partial — assert what jsdom
  supports; verify Esc/focus/backdrop **live in the browser**).
- **Live/browser verification** (per project convention — App.svelte + CSS +
  modal focus/Esc behavior can't be fully trusted from unit tests): enter Auto
  Albums, confirm the setup modal (Esc closes, focus trapped/restored), 1-min
  default, Auto button, template live preview + nested-folder preview, type an
  album name then move the slider and confirm it's kept, and that ManageLibrary /
  ShortcutsOverlay / dropdowns all dismiss correctly.

## Versioning & docs

- Patch bump per change (`2.8.x-alpha`), `CHANGELOG.md` updated in the same
  commit that lands each user-facing slice, newest first, user-facing wording.
- File the two deferred GitHub issues (AI names; change-album-date) in
  `john-guerra/autoPhotoOrganizer` and reference them from the CHANGELOG/PR where
  relevant.

## Risks / notes

- `d3.timeFormat` token set differs subtly from POSIX strftime for a few codes;
  document the supported subset in the modal legend so the preview is the source
  of truth.
- Reactive `bind:open` ↔ imperative `showModal()`/`close()` must not loop; guard
  with the dialog's actual `.open` state before calling.
- Name-persistence keyed to first-photo id: if two albums could ever share a first
  photo they can't (clusters partition the set), so the map key is unique per
  cluster — safe.

---

## Revision 1 — mid-build feedback + architect review (2026-07-11)

Five new user requests and a critical architect review reshaped the epic into
two phases. **This revision governs where it conflicts with the original body.**

### Corrections to the original design

- **"No backend changes" (original Goals/§B7) was wrong.** Materialize needs
  real backend work (below). The nested-name / `mkdirSync recursive` /
  `safeResolve` observations remain true; the "no change" conclusion does not.
- **The standalone `AlbumsView` mode is now interim.** A loupe round-trip drops
  its materialize/setup state and it re-implements feed features. Phase 2
  replaces it with an in-feed "Split into albums" flow. Phase 1 still polishes
  AlbumsView (users have it meanwhile) but the AlbumsView-specific wiring is
  explicitly time-boxed; the naming helpers, prefs, setup modal (gap+naming
  half), and backend fixes are permanent.

### Phase 1 — build now (this plan)

1. **Modal foundation** — `Modal.svelte` (native `<dialog>`), retrofit
   `ManageLibrary` + `ShortcutsOverlay`, dropdown dismissal. (Unchanged.)
2. **Auto Albums naming** — button/tooltip; strftime template + live preview;
   **setup modal built as a reusable config dialog** (gap+naming half kept
   structurally separate from the move+dest half); global prefs;
   first-photo-keyed names. (Tasks 1–2 done.)
3. **Materialize freeze fix — async fs, not `setImmediate`+sync.** Convert
   `copyIdsIntoFolder` and `moveFile`'s EXDEV branch to `fs/promises`
   (`copyFile`) so copies run on the libuv threadpool and never block the
   Electron **main-process** event loop (the server is embedded in the main
   process via `electron/main.js`). Keep same-volume `renameSync` (instant,
   atomic). Per-file `AbortSignal` checks and the partial-manifest-on-abort
   contract are preserved.
4. **Materialize destination defaults — mode-dependent.** Move → in-place
   (current/source folder); Copy → `~/Desktop`. Add `GET /api/system/paths`
   (`{home, desktop}` via `os.homedir()`, works in dev + packaged). Default dest
   swaps on Move↔Copy toggle, honoring the `destEdited` latch. `albumPrefs` does
   NOT store dest (it's mode-derived).
5. **Cross-volume move warning.** Compare `statSync(src).dev` vs
   `statSync(dest).dev`; when a Move destination is on a different volume, warn
   "this is a full copy, not an instant move." (SD-card→Desktop move is
   inherently a byte copy; the Copy→Desktop default is the right card-import
   path.)
6. **Post-materialize auto-rescan.** After a successful materialize, call the
   existing `POST /api/scan` on the destination so the created nested tree
   appears in the sidebar immediately. This also fixes the **Copy path indexing
   gap** (the copy branch inserts no DB rows today), making "see the recursive
   tree right after materialize" work for both Move and Copy.
7. **Group by folder name (smart-labeled).** New grouping that keeps each folder
   its own group (group key stays per-folder `abs_path` — no cross-library
   merge) but renders a **concise leaf label**, disambiguating namesakes by
   extending with parent segments (`2017_DCIM`) using a configurable separator
   (default `_`) — shortest-unique-suffix labeling computed over the loaded
   groups. (Not the naive `basename` SQL expr, which would merge all namesakes
   library-wide and mishandle Windows separators.)
8. **Tests** — videos-in-timeline as an honest **regression guard** (they're
   already unfiltered); a **nested-name collision** test (two albums rendering
   the same nested path must not become confusing siblings like `2017` →
   `2017_2`).

### Phase 2 — design carefully, then build (separate spec: the "in-feed" epic)

Filed as a GitHub epic; needs its own brainstorm/spec. Key items and the crux:

- **In-feed "Split into albums"** replacing `AlbumsView` — per-group action
  (button / right-click), parent group's name as album-name prefix,
  loupe-safe, state-preserving. Reuse the burst **algorithm** (`detectBursts`
  gap-walk) but the **section-header** render path, NOT burst stacks (albums
  keep every photo visible; bursts collapse to a cover).
- **CRUX (resolve before estimating):** album boundaries are **global to a
  group**, but the feed loads a **60-row window** and can't place a whole-group
  boundary from a window. Needs a server endpoint returning **album-boundary
  photo-ids per group** so the feed renders sub-dividers while paging (or load
  the group's whole timeline on split). "Expand/collapse is free from feed
  sections" is FALSE — this is the hard part.
- **Group by full nested path** (variable-depth hierarchy). The feed's
  fixed-depth keyset model (N dims = N levels, one SQL expr = one level) can't
  express it. First scope against the existing `server/db/tree.js` to see how
  much variable-depth hierarchy the sidebar already models.
- **Backend processing subsystem** — move heavy fs into an Electron
  `utilityProcess`/`worker_thread` (main loop never at risk for huge jobs) +
  **SSE/WebSocket progress streaming** (replaces polling). Design the worker
  contract to return **partial manifests on abort** so undo survives the process
  boundary (the manifest is already serializable `{id,from,to}`). Web
  Workers/WebSockets alone do NOT fix the freeze — the freeze is a blocked Node
  main-process loop, a different layer.

### Deferred → standalone GitHub issues

- AI-generated meaningful album names (keep the app free/offline).
- Shift the capture date of a whole album (fix a wrong camera clock).
