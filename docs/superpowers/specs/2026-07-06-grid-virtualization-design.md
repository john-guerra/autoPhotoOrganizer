# Grid virtualization — Design

Status: Approved, ready for implementation plan
Date: 2026-07-06

## Context & problem

The justified grid (`ui/src/App.svelte`, commit `a77e2e5`) mounts one `Thumb`
component per photo, absolutely positioned by boxes from
`ui/src/lib/layouts/justified.js`. Each `Thumb` owns an `IntersectionObserver`
(for lazy image loading) regardless of whether the tile is anywhere near the
viewport. This is v0.2 backlog item #1 (`docs/ROADMAP.md`): at 10,172 photos
it already means 10k+ live DOM nodes and observers; the roadmap's stated
ambition is "millions," which this does not scale to.

## Goal

Only mount `Thumb` components for boxes near the viewport, so DOM node count
(and observer count) stays roughly flat regardless of folder size, while
preserving every existing interaction: keyboard grid navigation, roving
focus, star rating, zoom, and the loupe.

## Decision: DOM virtualization, not GPU

Considered pulling the GPU/canvas renderer (regl/pixi/deck.gl) forward from
its Phase 2+ slot in the rendering-strategy doc. Rejected for the cull-grid
use case:

- **Keyboard nav and focus are DOM-native and explicitly valued** (roving
  focus, `scrollIntoView`, selection ring via `<button>` — see
  `ui/src/lib/Thumb.svelte`). A canvas renderer has none of this for free;
  it would need a hand-rolled focus model, hit-testing, and selection
  overlay to get back to parity with what exists today.
- **Virtualization, not the renderer, is what makes "millions" tractable
  for a linear-scroll cull grid.** Only ~50–150 tiles are ever visible at
  once regardless of total archive size. GPU's real payoff is a different
  interaction — a zoomed-out view of the *entire* archive rendered at once
  (PhotoMesa-style semantic zoom), where nothing can be virtualized because
  everything genuinely is on screen simultaneously. That's the separate
  "archive exploration" tier already recorded in
  `docs/superpowers/specs/2026-07-06-photo-triage-design.md` under
  "Rendering strategy" — not a replacement for the cull grid.

This keeps the existing two-tier split intact: DOM virtualization now for
culling, GPU/atlas streaming deferred to archive-zoom.

## Scroll model

The page keeps scrolling as a whole (sticky topbar, no `overflow` on
`.grid`) — no layout change. Virtualization reads
`gridEl.getBoundingClientRect()` each recompute to get the grid's current
offset from the viewport, so the math needs no separate scroll-position
bookkeeping and stays correct regardless of what's above the grid.

## Algorithm — a new pure function

`ui/src/lib/layouts/windowing.js`, following the same pure-function pattern
as `justified.js` (no DOM, no Svelte, unit-testable in isolation):

```js
export function visibleRange(boxes, { scrollTop, viewportHeight, overscanPx = 800 }) {
  // boxes sorted ascending by y (guaranteed by justifiedLayout: rows are
  // emitted in order, all boxes in a row share one y).
  // Binary search for:
  //   start = first index where box.y + box.height >= scrollTop - overscanPx
  //   end   = last index where box.y <= scrollTop + viewportHeight + overscanPx
  // Returns { start, end } (inclusive indices into boxes/items), or
  // { start: 0, end: -1 } for an empty range.
}
```

This function is specific to row-based, y-sorted layouts (true for
justified). A future non-row layout (e.g. an embedding scatter) would need
its own visibility query (2D range, not 1D) — that's expected: it's the
same per-layout seam the layout module already is, not something to
generalize before a second layout exists to validate the abstraction
against.

## Svelte integration (`App.svelte`)

- Recompute triggers: window `scroll` and `resize` events, throttled to
  once per animation frame (`requestAnimationFrame` guard, so a burst of
  scroll events collapses to one recompute per frame); also recompute
  whenever `boxes` changes (zoom level change, meta enrichment refining
  aspect ratios, rescan).
- **Rendered set = `visibleRange(...)` ∪ `{selected}`.** Forcing the
  selected index into the rendered set means keyboard jumps (Home/End, or
  holding an arrow key past the rendered window) mount the target `Thumb`
  on demand; its existing reactive `scrollIntoView` block
  (`Thumb.svelte:42`) then scrolls it into view with no new focus-handling
  code in `App.svelte`.
- The `{#each items as item, i (item.id)}` loop iterates only indices in
  the rendered set, still keyed by `item.id` — Svelte correctly
  mounts/destroys `Thumb` instances (and their `IntersectionObserver`s) as
  items scroll in and out of range.
- `overscanPx` default: 800px (roughly one extra viewport height above and
  below), tunable if scroll pop-in is visible at the default.

## Alternatives considered and rejected

- **Generic virtual-list library** (e.g. svelte-virtual): assumes uniform
  row height or single-column lists. Justified rows have variable height
  and variable item count per row — a library would fight the shape more
  than a ~30-line binary search costs to write.
- **CSS `content-visibility: auto`**: smaller diff (a CSS rule +
  `contain-intrinsic-size`), but only skips paint/layout cost — it does not
  reduce live DOM node or `IntersectionObserver` count, which is what
  actually matters at the "millions" scale the roadmap targets.
- **Pulling GPU rendering forward**: see "Decision" above.

## Testing

- `ui/src/lib/layouts/windowing.test.js`: unit tests against synthetic box
  arrays (dense grid mimicking 10k justified boxes) — assert correct
  `{start, end}` at various `scrollTop`/`viewportHeight` combinations,
  including edges (scrolled to top, scrolled past the end, empty `boxes`).
- Existing `justified.test.js` and component behavior unaffected — this is
  purely an additional windowing layer over the existing box output.

## Validation

After implementation, run against the 10,172-photo Pixel folder
(`/Users/aguerra/Pictures/fotos_bk/2025_10Oct_30_Backup_cell_pixel9pro/DCIM/Camera`
— read-only, per `docs/ROADMAP.md` working agreements) and report the
mounted `Thumb` count at a given scroll position (should stay in the
low hundreds regardless of total count) plus a qualitative scroll-feel
note. John does the visual verification at `localhost:5173` himself per
the working agreement — no automated browser verification unless
requested.

## Out of scope

- Any change to the loupe (`Loupe.svelte`), which already operates on the
  full `items` array independent of grid virtualization.
- Generalizing `visibleRange` to non-row-based layouts (treemap, embedding
  scatter) — deferred until one of those layouts actually exists.
- Pulling any GPU/canvas rendering work forward from Phase 2+.
