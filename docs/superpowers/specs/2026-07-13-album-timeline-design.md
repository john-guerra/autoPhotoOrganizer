# Album timeline — design

A timeline at the top of the Auto Albums view showing **the time range analyzed**
and **where the break points fall**, with each album color-coded and linked to its
divider in the list below.

Today `AlbumsView` shows albums as a vertical list of dividers. You tune the gap
threshold with a slider and watch the album count change — but you cannot _see_
the thing you are tuning. A gap is a temporal fact, and the view has no time axis.

The legacy app had this: `legacy/2024-electron-standalone/photoTimelineChart.js`
drew a `d3.time.scale`, one dot per photo, and album regions as rects filled from
`d3.scale.category20()` at `fill-opacity 0.2`. This is that idea, rebuilt on the
current stack.

## Scope

**Viewer, not editor.** Album boundaries remain a pure function of the gap
threshold: you tune `k` (or an exact gap) and the break points move. The timeline
never edits them. That keeps album state exactly as it is today — nothing new to
persist — and it ships small. Dragging/splitting/merging boundaries directly on
the timeline is a real idea, and it is explicitly **out of scope**; it would make
boundaries "the threshold's answer, plus overrides", which needs override state
that survives re-clustering, and undo.

## What it shows

Four layers, sharing one x-scale, stacked in one strip:

```
┌─ sticky ───────────────────────────────────┐
│ ████████ ███ ▓▓▓▓▓▓▓▓ ████    ██           │  album bands (colored)
│ ••••• •••│•• ••••│•••••••• ••│  •••        │  one dot per photo
│ ▁▂▅█▆▃  ▁│▃▅▃▁   │▁▄██▆▃▁    │  ▁▃▅▃       │  KDE density
└─┴────────┴───────┴───────────┴─────────────┘  zoomable time axis
  Jan 3    Jan 5   Jan 9       Jan 14
           ▲ you are here
```

- **Album bands** — one rect per album, spanning `[startAt, endAt]`. The gaps
  _between_ bands are the break points; they are the whole point of the chart, so
  they are rendered as literal empty space, not as lines.
- **Photo dots** — one dot per photo. This is what makes a gap legible as absence.
- **KDE density** — the shape of the working set at a glance (the axis widget
  draws this already).
- **Time axis** — the analyzed range, with zoom handles and drag-to-pan.

## Architecture

Three new units. Everything that can be tested without a DOM is pulled out of the
component on purpose.

### `ui/src/lib/albumColors.js` (pure)

```js
albumColor(index) -> string   // cyclic categorical scheme
```

Keyed by **index**, not by name. Legacy keyed `category20()` by album name, which
means two adjacent albums can hash to neighbouring hues; indexing guarantees
consecutive albums differ. This one function is the entire "connection" between
the chart and the list: the band and its divider chip call it with the same `i`.

### `ui/src/lib/albumTimeline.js` (pure)

```js
analyzedDomain(photos) -> [minMs, maxMs]      // the range actually analyzed
nearestPhoto(times, t) -> index | -1          // binary search; times are sorted
albumAtTime(albums, t) -> albumIndex | -1     // which band is under a time
```

`nearestPhoto` is a binary search, not a quadtree: `photos` is already ascending
by `t` (the server orders it), so the sorted array we are handed IS the index.

### `ui/src/lib/AlbumTimeline.svelte` (view)

Props: `photos`, `albums`, `names`, `truncated`, `total`, `hoveredIndex`,
`viewportIndex`. Events: `hover` (index | null), `select` (index).

Layers, bottom to top:

1. `zoomableAxisInput` from `@john-guerra/d3-zoomable-axis` — axis, ticks, KDE
   scent, zoom handles, drag-to-pan, and its own settings popover. Mounted with a
   Svelte action, the same pattern `TimelineFilter.svelte` already uses.
2. A `<canvas>` for the dots.
3. An `<svg>` for the album bands and the markers.

## The zoom model (the one subtle thing)

`zoomableAxisInput` is a **range selector over its scale**: the handles emit
`[lo, hi]` in data space and the _consumer's_ chart zooms (`chart.zoomX(v)` in the
widget's own README). The axis does not re-tick itself.

So if we zoomed only our layers, the dots would drift out of alignment with the
ticks — the exact pixel-offset bug the widget exists to prevent.

Instead, **the widget's scale is the view**. Zooming means rebuilding the widget
with the new domain, so ticks, KDE, bands and dots all derive from one scale and
line up by construction:

```
viewDomain = [min, max]              // the analyzed range
on axis input [lo, hi]  ->  viewDomain = [lo, hi]   (rebuild the widget)
reset (double-click / ⤢) ->  viewDomain = analyzedDomain(photos)
```

`TimelineFilter` already rebuilds the widget when its domain changes, so this is
an established pattern in the codebase, not a new one.

**This is deliberately NOT `TimelineFilter`.** That component's emitted range
_means filter_ (it sets `filter.dateFrom/dateTo`); here the identical gesture must
mean _zoom_. Reuse the **widget**, never the **component** — one component with
two contradictory meanings for its core output is how you get a mode flag and a
500-line file.

## Why the dots are on a canvas

`AlbumsView` fetches up to **20,000** photos by default (the server hard-caps at
200,000). 20,000 SVG `<circle>` elements re-created on every `k` change would
jank — and `k` is a _slider_, so that is the one interaction that must feel
instant. A canvas redraws 20,000 dots in about a millisecond.

The bands stay SVG: there are orders of magnitude fewer of them, and they need to
be hover/click targets.

## Linking the list and the chart

Bidirectional, driven by `AlbumsView`, which already owns `albums` and `names`:

- **Shared color.** Each divider gets a chip in `albumColor(i)`; the band uses the
  same. The chart is the legend for the list.
- **Hover either way.** Hover a band → its divider highlights. Hover a divider →
  its band highlights (`hoveredIndex` flows down; `hover` events flow up).
- **Click a band → scroll to its divider.** `select` → `AlbumsView` scrolls the
  divider into view (`scrollIntoView({block: "start"})`).
- **"You are here".** As you scroll the list, a marker on the timeline tracks the
  album at the top of the viewport. Each `.album-divider` is _already_
  `position: sticky; top: 0` inside `.albums-scroll`, so "the album at the top" is
  simply the divider currently stuck — found by comparing divider offsets to the
  container's `scrollTop`, on a `scroll` listener.

## Sticky

Free. `.albums-view` is a flex column in which only `.albums-scroll` scrolls; the
timeline is a flex-none row above it, so it stays put while the list scrolls
underneath. No `position: sticky` needed on the timeline itself.

## Never fail silently

- **Truncation is stated on the chart.** `AlbumsView` already receives a
  `truncated` flag: the working set can be capped at `limit` (default 20,000) out
  of a much larger library. A timeline that drew a partial range as though it were
  the whole library would be a lie, and a quiet one. When `truncated`, the strip
  says so: _"Analyzed the first 20,000 of 114,125 photos — everything after Mar 4,
  2019 was not clustered."_
- **No photos / no time span.** If `photos` is empty, or every photo shares one
  timestamp (`max === min`, a real case for a scanned folder), the chart renders a
  short explanatory line instead of a degenerate zero-width axis.
- **The dots are sampled only if they must be.** If the working set ever exceeds
  what the canvas can honestly draw, the strip says how many are shown. It never
  silently thins them.

## Testing

- **Vitest, on the pure modules** (`albumColors`, `albumTimeline`): adjacent
  albums never share a color; `nearestPhoto` finds the true nearest (property test
  against a linear scan); `albumAtTime` returns -1 inside a gap; the degenerate
  inputs above (empty, single photo, all-identical timestamps) return sane values
  rather than `NaN`.
- **Live verification in the browser** for the component, per the repo's standing
  rule for anything visual: drag `k` from one album to hundreds and watch the
  bands re-flow; zoom into a dense week; click a band and land on the divider;
  scroll the list and watch the marker track.

## Out of scope

- Editing boundaries (drag / split / merge) — see Scope.
- Persisting albums. They remain ephemeral, discarded when you leave album mode.
- A post-materialize report. The timeline is on the _review_ screen, before you
  commit.

## Versioning

Patch bump + a `CHANGELOG.md` entry in the same commit, per `CLAUDE.md`.
