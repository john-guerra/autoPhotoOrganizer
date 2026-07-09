# Menu-bar redesign: inline stateful filters + clustered toolbar — design

_Date: 2026-07-08. Follow-up to `2026-07-08-filter-panel-design.md`._

## Problem

The filter lives in a `Filter ▾` popover, so the active filter state is invisible
without opening it — you can't tell at a glance what's being hidden. Separately,
the menu bar has ~13 controls in one flat, ungrouped row that overflows (burst
value clipped) and wraps badly (group-by pills shove the title).

## Goals

1. **Filter state always visible** — no popover; the current rating threshold and
   orientation selection are readable at a glance and directly manipulable.
2. **Reorganize the bar** into three labeled-by-layout clusters so each control's
   purpose is obvious, and fix the wrapping/overflow.

Filter **semantics are unchanged** (`filterSpec.js` / `buildFilter`): rating is a
`≥N` threshold (0 = Any); orientation is a multi-select where all-3-or-0 = off.

## Layout — one row, three clusters

```
AutoGallery  │ [Library ▾] [＋] │ [year][month][day +]  ≥ ★★★★☆  ▭ ▮ □  ✕ │ Tree│Fisheye  ⌖ Locate  ( ▦──▦  ☑Burst ⧉──2.0s ) │            status ›
             └ SOURCE ────────┘ └ ORGANIZE & FILTER ───────────────────┘ └ VIEW ─────────────────────────────────────┘
```

- Thin `1px` (`#2a2a2a`) vertical dividers between clusters; consistent gaps.
- `status` + thumb-progress pushed to the far right (`margin-left:auto`), muted, so
  they no longer compete with controls.

### ① Source

- **`Library ▾`** — recent folders + "Manage library…", as today.
- **`＋` Add folder** — a small button whose popover contains the `/path` text
  input (paste + Enter to scan) and the `Choose Folder…` native-picker button.
- The always-visible `/path` input, `Scan`, and `Choose Folder…` buttons are
  **removed from the top bar** (scanning is occasional → earns one click).
- Empty-library state: the `＋` remains obviously available; if no folders are
  scanned yet, the main area's existing empty prompt covers discovery.

### ② Organize & Filter

- **Group-by pills** — the existing `MultiAutoSelect`, but its wrapping contained
  within this cluster so it can no longer push the title/other clusters.
- **RatingFilter** (new inline widget): a small leading `≥` label, then five `★`.
  - Filled amber (`#ffc93c`) for slots `1..minRating`; empty (`#4a4a4a`) beyond;
    `minRating: 0` (Any) → all five empty. Reuses `Stars.svelte`'s exact glyph +
    colors so it rhymes with the rating stars.
  - **Hover** star `k` → preview fill `1..k`.
  - **Click** star `k` → set `minRating = k`; **click the current threshold star
    again** → clear to `0` (Any).
  - `role="group"`, per-star `aria-label` ("filter: 3 stars or more").
- **OrientationFilter** (new inline widget): three small **CSS-drawn** shape
  toggles — landscape (wide rect), portrait (tall rect), square. Lit (accent
  fill/border) when included, dim outline when excluded. Default all-three-lit =
  "showing all" (no constraint); toggling any off highlights the active subset.
  Buttons with `aria-pressed`.
- **`✕` Clear** — appears **only when a filter is active** (`isActive(filter)`),
  clears rating + orientation to `DEFAULT_FILTER` in one click.

### ③ View

- **Tree│Fisheye** toggle and **Locate**, as today.
- A single grouped **view cell** (one rounded container, like the sidebar-toggle
  pill) holding:
  - **Zoom/density** slider (`▦──▦`), unchanged.
  - **Burst controls**: a **checkbox** labeled "Burst" that enables/disables burst
    grouping, plus the burst-gap slider + value (`⧉──2.0s`). When unchecked the
    slider is disabled/dimmed and burst detection is off; the gap value is
    remembered so re-checking restores it.

## Behavior

- **Burst enable/disable**: new persisted `burstEnabled` state. Burst detection
  uses `gapMs: burstEnabled ? burstGapMs : 0` (gap 0 = no grouping), so unchecking
  disables bursts without losing the chosen gap. Persisted to localStorage
  (`autogallery.burstEnabled`) alongside the existing `burstGapMs`.
- **Filter changes** still route through the existing `onFilterChange` (unchanged)
  — the inline widgets emit the same `change` events the popover did.

## Components / files

- **New**: `ui/src/lib/RatingFilter.svelte`, `ui/src/lib/OrientationFilter.svelte`
  (small, presentational, `export let filter` + `change` event; pure logic
  testable).
- **Remove**: `ui/src/lib/FilterPanel.svelte` (and its test) — replaced by the two
  inline widgets. `filterSpec.js` is reused unchanged.
- **Edit**: `ui/src/App.svelte` — restructure the `.topbar` markup into the three
  clusters + dividers; fold path/Scan/Choose-Folder into an inline `＋` add-folder
  popover; add the grouped view cell + `burstEnabled`; mount the two filter
  widgets; move status right.
- The toolbar markup **stays inline in App.svelte** (not extracted to a `<Toolbar>`
  component) — it binds to ~15 pieces of App state (dir, scanning, zoom,
  burstGapMs, groupBy, filter, sidebarMode…), so extraction would mean threading
  all of them as props/events for little gain. Only the genuinely self-contained
  new widgets become components.

## Testing

- **Unit** (`RatingFilter.test.js`, `OrientationFilter.test.js` — or extend
  `filterSpec.test.js`): the pure click→spec mapping — click star k ⇒
  `minRating=k`; click active star ⇒ `0`; toggle a shape ⇒ correct
  `orientations` array; all-off / all-on edge cases.
- **Live browser verification** (required — CLAUDE.md flags App.svelte/CSS, and the
  memory note "live-verify-ui-beyond-review"): in the real app confirm the star
  widget sets/clears the threshold and the grid+counts respond; orientation
  toggles read correctly; `✕` clears; the `＋` add-folder flow scans; burst
  checkbox enables/disables grouping; no wrapping/overflow at the normal window
  width; clusters/dividers render as designed.

## Out of scope

- Changing filter semantics or adding new facets (camera/ISO filtering — that's a
  later slice; a "More filters ▾" can return then if the inline row gets crowded).
- Extracting a full `<Toolbar>` component.
- Indexing videos for the `kind` dimension.
