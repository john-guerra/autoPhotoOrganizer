# Auto Albums polish + native-`<dialog>` modal foundation

**Date:** 2026-07-11
**Status:** Approved design, ready for plan
**Related:** builds on `2026-07-10-albums-editable-names-inplace-design.md` and
`2026-07-09-fisheye-snapshot-view-design.md`.

## Problem

The auto-albums feature is the product's headline user story — *"I come back from
a trip with thousands of photos+videos; split them into per-day / per-event
groups and drop them into dated folders"* — but it is under-explained and
under-configurable:

- The entry button just says **Albums** with a terse tooltip; a first-time user
  doesn't know what will happen.
- There is no up-front explanation of *how* clustering works before it reorganizes
  the view.
- The only naming scheme is a fixed `YYYY-MM-DD`; the legacy tool had a
  configurable date-format + prefix + index, and the user's real-world convention
  nests a **year subfolder** (`2017/2017_01Jan_09_Diana_VR`).
- Typed album names are **lost** whenever the split slider re-clusters (they are
  re-seeded on any structural change).
- The default split threshold is the statistical `mean + k·stddev`, which is a
  good *auto* mode but a poor *default* to reason about; the user wants a concrete
  **1-minute** starting point with *Auto* as an explicit button.

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
- Tooltip: *"Group the photos you're viewing into albums by the pauses between
  shots — a long gap starts a new album. Preview, rename, then save them into
  folders (photos and videos)."*

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
   *"AutoGallery looks at when each photo and video was taken. When there's a long
   pause between shots, it starts a new album. Drag the split gap to make albums
   bigger or smaller, or let AutoGallery pick a gap automatically."*
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
*structure/semantics*, not its CSS:

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

*(Note: the inner native `confirm()` calls are a separate concern — leave them for
now, or track as a follow-up; not in scope.)*

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
