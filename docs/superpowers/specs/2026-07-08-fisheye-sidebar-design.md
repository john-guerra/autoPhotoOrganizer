# Fisheye sidebar navigator — Design

**Date:** 2026-07-08
**Status:** implemented on the fisheye worktree branch; pending John's live verification.
**Related:** the tree sidebar (`2026-07-06-tree-sidebar-design.md`) it toggles against;
inspiration from John's PhotoRing `navigationList.js`.

## Context & problem

The tree sidebar (`TreeSidebar.svelte`) is a classic expand/collapse tree. Two
gaps from live use: folder rows show near-identical `abs_path` strings whose
differentiating tail is ellipsis-truncated (the list reads as noise), and it
gives no sense of **where you are** in the whole library or how far a jump is.

We add a **fisheye / focus+context navigator** as a _toggle-able alternative_
(persisted `sidebarMode`), plus a label-shortening fix that also improves the
tree.

## Design

A single fixed-height column over the **finest** grouping level of the current
`groupBy`, magnifying the current position and its neighbourhood, compressing
distant regions, with **checkpoint bands** at outer-dimension (year/month)
boundaries. The "you are here" marker **continuously follows the feed's scroll**;
clicking a leaf/checkpoint jumps the feed.

### Data — `server/db/tree.js` `getFlatTree(db,{groupBy})`

One `GROUP BY` over all groupBy dimensions, ordered exactly as the feed orders
groups (`resolveDimensions` + per-dim direction). Returns
`{ total, leaves:[{ values:{dim:value}, count }] }` in feed order. Bounded by the
number of distinct leaf groups; one query per groupBy change. Exposed at
`GET /api/tree/flat`; client helper `fetchFlatTree` in `ui/src/lib/api.js`.

### Distortion — `ui/src/lib/fisheye.js` (pure, tested; uses `d3.scaleLinear`)

Reformulated from PhotoRing's absolute-position fisheye scale to a
degree-of-interest **weight → cumulative layout**, which guarantees the column
fills the viewport, `y` is monotonic, and thickness is positive:

- `doiWeight(dist)` — flat in the near zone (`vicinity`), smooth lens decay
  (`falloff`, `distortion`) outside.
- `deriveCheckpointDepth(leaves, groupBy)` — shallowest outer dimension that
  changed vs. the previous leaf (year/month boundaries); `null` for plain leaves.
- `sampleLeaves(...)` — decimates long lists to ~`height/minRowPx` rows but
  force-keeps the near zone, every checkpoint, and endpoints; **sums skipped
  counts** into the kept row's `binCount` so the histogram silhouette loses no
  photos (PhotoRing's aggregation).
- `layoutFisheye(...)` → `{ rows:[{i,y,thickness,binCount,checkpointDepth,values,count}], maxBinCount }`.
- Tuning knobs (`FISHEYE_DEFAULTS`) are exposed for John to tune — his domain.

### Labels — `ui/src/lib/labels.js` `shortLeafLabel(dimension,value,prevValue)`

Folder → basename (parent/basename on collision); dates → the differentiating
component with coarser context added only where it changed vs `prevValue`;
`""` → "Unknown". Used by the fisheye AND retrofitted into `TreeNode.svelte`.

### View + wiring

- `ui/src/lib/FisheyeSidebar.svelte` — SVG column, count-weighted bars, shortened
  labels, checkpoint bands, a dot at the current position; `mousemove` sets a
  transient hover focus, `mouseleave` snaps back to current; click → `jump`.
- `ui/src/App.svelte` — persisted `sidebarMode` with a topbar toggle; renders
  `TreeSidebar` or `FisheyeSidebar`. `currentPath` is derived from the first
  visible feed entry via the existing `renderStart`/`updateVisibleRange` window
  (read-only — never scrolls the feed, honouring issue #40). Click-to-jump
  reuses `jumpToPath`.

## Testing

- Unit (vitest): `fisheye.test.js` (10), `labels.test.js` (14), `tree.test.js`
  extended (`getFlatTree`, 4). Full suite: 254 passing. Vite build compiles.
- Live (John, per working agreement): toggle persistence; dot follows scroll with
  no feed hijack; hover magnifies and snaps back; leaf/checkpoint click jumps;
  `[folder]`, `[year,month,day]`, reordered groupBy; the 10k-photo folder for
  sampling; tree labels now show differentiating segments.

## Out of scope

Album/tag dimensions; horizontal orientation; persisting hover state; changes to
feed pagination / rating / burst-stacks / loupe.
