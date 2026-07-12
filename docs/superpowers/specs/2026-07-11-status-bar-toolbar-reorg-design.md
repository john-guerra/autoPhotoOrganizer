# Status bar + toolbar reorg (#82)

**Date:** 2026-07-11
**Issue:** [#82](https://github.com/john-guerra/autoPhotoOrganizer/issues/82) — Toolbar reorg: group-by stays in top toolbar, ambient state → bottom status bar
**Branch:** `feat/82-status-bar-toolbar-reorg`
**Related:** #57 (toolbar redesign), #88 (group-label actions — separate worktree, not in scope here)

## Problem

The top toolbar (`ui/src/App.svelte`, `<header class="topbar">`) crams every control into
one row: source, group-by + sort + filter, view actions, zoom, burst, a counts block,
selection/materialize, and a transient status line. The group-by control — a third-party
`MultiAutoSelect` pill widget — is **inherently ~2 rows tall** because it stacks a text input
above its pills. The combined width plus that tall widget forces the toolbar to wrap onto a
second row.

Two independent problems are bundled here:

1. **Ambient read-only state is mixed in with actions.** Counts, zoom, burst, sort, and the
   status/progress text are all read-only or set-and-forget state that doesn't belong in an
   actions toolbar.
2. **The group-by widget is tall by construction**, so even after freeing horizontal room the
   toolbar can still wrap.

## Goal

Separate **actions** (top toolbar) from **ambient state** (new bottom status bar), and give
the group-by widget a **compact single-row layout** so the toolbar stops wrapping.

Per the issue's revised direction (issue comments), **group-by stays in the top toolbar**
alongside filter (both are "organize the view" controls); only ambient state moves down.

## Non-goals

- No change to grouping/sort/filter _behavior_ — controls only relocate; their events and
  the state they drive stay in `App.svelte`.
- Not touching #88 (consistent group-label actions + tri-state selection icon) — that is a
  separate branch/worktree.
- Not merging JobsPanel into the status bar. JobsPanel stays the detailed job/scan surface;
  the status bar only shows the existing transient status/error + thumb-progress text.

## Current state (what moves)

| Element                                                                         | Today (in `App.svelte` topbar)  | After                                    |
| ------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------- |
| `library / showing / selected` counts                                           | `.counts` block (~L2801)        | Status bar, left                         |
| status / error text                                                             | `.status` span (~L2850)         | Status bar, left (after counts)          |
| thumb-progress counter                                                          | `.thumb-progress` span (~L2851) | Status bar, left (after status)          |
| zoom                                                                            | `ViewControls`                  | Status bar, right                        |
| burst toggle + gap                                                              | `ViewControls`                  | Status bar, right                        |
| sort (attr + direction)                                                         | `OrganizeControls`              | Status bar, right (rightmost)            |
| group-by widget                                                                 | `OrganizeControls`              | **Stays** in top toolbar, compact layout |
| source, filter, view actions, selection/materialize, keep/focus chips, `?` help | topbar                          | **Stay** in top toolbar                  |

## Design

Delivered in two parts, **status bar first** (banked as a checkpoint commit before the widget
work).

### Part A — Bottom status bar (AutoGallery)

New presentational component `ui/src/lib/StatusBar.svelte`, rendered as
`<footer class="statusbar">` as the last child of `.app` (below the feed). It owns no logic;
`App.svelte` passes state down as props and receives change events for the interactive bits
(zoom / burst / sort) exactly as `ViewControls` / `OrganizeControls` do today — the handlers in
`App.svelte` (`onSortChange`, the `zoom` / `burstEnabled` / `burstGapMs` binds) are unchanged.

**Layout:** `[ counts · status · thumbs ] ⟨flex spacer⟩ [ zoom ] [ burst ] [ sort ]`

- **Left region:**
  - counts: `{libraryTotal} library · {showingCount} showing · {selectedCount} selected`
    (the `has-sel` emphasis when `selectedCount > 0` is preserved).
  - transient status/error text (`error || status`, with the `err` class), then the
    thumb-progress counter (`thumbProgress`, with its `err` class when `thumbCounts.error > 0`).
- **Right region:** `zoom`, then `burst` (toggle + gap), then `sort` (attr select + direction
  toggle) as the rightmost item.

**Prop / event contract (StatusBar):**

- Props in: `libraryTotal`, `showingCount`, `selectedCount`, `status`, `error`,
  `thumbProgress`, `thumbCounts`, `zoom`, `zoomMax`, `sort`, and `bind:burstEnabled`,
  `bind:burstGapMs`, `bind:zoom`.
- Events out: `sortchange` (mirrors OrganizeControls' current event). zoom/burst use
  two-way `bind:` like ViewControls does today.

The zoom / burst / sort markup is **moved, not rewritten** — lift the existing elements and
their scoped CSS out of `ViewControls.svelte` / `OrganizeControls.svelte` into
`StatusBar.svelte` so behavior is byte-for-byte the same, only relocated.

### Part B — Compact group-by layout (`multi-auto-select` repo)

The widget lives at `/Users/aguerra/workspace/multi-auto-select` (John owns it; published to
npm as `multi-auto-select`, AutoGallery depends on `^0.0.11`).

Add a **backward-compatible** init option — `layout: "inline"` (default `"stacked"`, the
current behavior) — to `src/index.js`:

- **Inline layout:** render the text input and the pills output (`fmOutput`) on **one flex
  row** — e.g. wrap `fmInput` + `.options` in a single `display:flex; flex-wrap:wrap;
align-items:center` container so pills sit _beside_ the input, growing the row's height only
  when they truly overflow. (Today `.options` is a separate block below the input.)
- **Omit empty chrome:** when `title` / `description` are falsy, don't render the `.title` /
  `.description` divs (they currently reserve vertical space).
- **Tighter pills in inline mode:** reduce pill vertical margin (`7px 2px` → ~`2px 2px`).
- The `sortablejs` reorder + drag-to-remove-area behavior is unchanged; only the DOM container
  arrangement and spacing differ.

Bump `0.0.11 → 0.0.12`.

**AutoGallery consumption:**

- In `OrganizeControls.svelte`, pass `layout: "inline"` to the `MultiAutoSelect(...)` call in
  `groupBySelector` (currently at `src/lib/OrganizeControls.svelte` ~L34).
- **Dev/verify:** `npm link` the local widget into AutoGallery's `ui/` so the reorg can be
  built and browser-verified before publishing.
- **Finalize (this branch or a fast follow):** publish `0.0.12`, then bump AutoGallery's
  `ui/package.json` dependency from `^0.0.11` to `^0.0.12` and unlink. The branch must not
  merge while pointing at a linked/`file:` dependency.

## Error handling / usability

Per CLAUDE.md "never fail silently": this is a pure chrome relocation — no new failure modes.
The transient status/error text and thumb-progress that already surface failures **keep
surfacing them**, now from the status bar. Nothing that could fail becomes a silent no-op; the
`.status` line's `err` styling and the thumb-progress `err` styling are preserved verbatim.

## Testing

- **Unit:** no new pure-logic modules, so no new `*.test.js` are strictly required. If any
  small helper is extracted (e.g. a counts formatter), colocate a vitest test for it.
- **Widget:** the `multi-auto-select` repo has mocha tests; add/extend a case asserting the
  inline layout renders input + pills in the single flex container and omits empty
  title/description. Default (`stacked`) behavior must remain unchanged.
- **Manual browser verification (required by project convention for `App.svelte`/CSS):**
  - Toolbar no longer wraps to a second row at the normal window width.
  - Status bar shows correct `library / showing / selected`, updates live on selection.
  - zoom / burst / sort operate identically to before from their new home.
  - Status/error text and thumb-progress appear in the status bar during a scan.
  - Group-by add / reorder / remove still works with the compact inline widget.

## Sequencing (checkpoint-friendly)

1. **Part A** — `StatusBar.svelte`, move counts/status/thumbs/zoom/burst/sort. Build + browser
   verify. **Commit** (`feat(ui): bottom status bar for ambient state (#82)`), bump patch
   version + CHANGELOG.
2. **Part B** — compact `layout:"inline"` in `multi-auto-select`, `npm link`, opt in from
   `OrganizeControls`, verify no wrap. **Commit** the AutoGallery side; bump patch +
   CHANGELOG. Publish `0.0.12` and switch the dep to `^0.0.12` (this branch or fast follow).

## Version / changelog

Two patch bumps in `package.json` (one per part), each with a user-facing `CHANGELOG.md` line
referencing #82, per the project's versioning convention. Keep the `-alpha` suffix.
