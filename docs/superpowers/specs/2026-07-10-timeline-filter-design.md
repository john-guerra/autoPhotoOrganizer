# Timeline filter — design

**Status:** approved (brainstorm 2026-07-10)

## Goal

Add an always-on, brushable **density timeline** under the toolbar that filters
the photo set by *when* photos were taken. Brushing a time range on it adds a
`dateFrom`/`dateTo` facet to the existing shared filter spec, so it narrows the
feed (and everything else) exactly like the rating and orientation filters do.

It is built on **`@john-guerra/d3-zoomable-axis`** (`zoomableAxisInput`), a d3
axis with dual drag-to-zoom handles that draws a "scented" KDE/violin of the
data distribution and emits a `[lo, hi]` range in data space.

## Decisions locked with the user

- **Role:** a new *filtering* method (not an album-boundary editor, not a feed
  scrubber).
- **Integration:** one facet of the **existing filter spec** — `dateFrom` /
  `dateTo` AND-combine with rating/orientation and honor the Display/Select
  mode toggle. No second, parallel filtering system.
- **Placement:** an **always-on** full-width strip between the toolbar and the
  feed (dynamic-query philosophy — persistent, tight feedback).
- **Density scope:** **crossfilter** — the histogram reflects the *other* active
  filters (rating/orientation) with the time facet itself excluded, refetching
  when they change.
- **Packaging:** a normal **npm dependency** (`@john-guerra/d3-zoomable-axis`),
  published by the author.
- **Timestamp:** reuse the server's canonical `t = COALESCE(taken_at, mtime)`.

## Architecture & data flow

```
        rating/orientation change ─┐        brush [lo,hi] ─┐
                                    ▼                       ▼
 filterSpec { rating, orientation, dateFrom, dateTo }  (App.svelte)
      │                                   │
      │ (non-time facets)                 │ (all facets)
      ▼                                   ▼
 GET /api/times?filter=…            GET /api/feed / tree / counts …
      │  {times,total,min,max}            │  buildFilter() adds the
      ▼                                   ▼  BETWEEN clause
 TimelineFilter.svelte  ◄── density ── one filter, composed everywhere
 (zoomableAxisInput)  ── emits [lo,hi] ─► sets filter.dateFrom/dateTo
```

The key leverage: the feed, tree, sidebars, and header counts **all** already
build their SQL through one `buildFilter(filterSpec)` (`server/db/feed.js`).
Adding the time facet to `buildFilter` makes it narrow every consumer for free —
no per-endpoint wiring.

## Components

### 1. Filter spec — `ui/src/lib/filterSpec.js` + server filter builder

- Extend `DEFAULT_FILTER` with `dateFrom: null, dateTo: null` (epoch ms).
- `isActive(filter)` returns true when either bound is set (so the ✕ clear-filter
  button appears and clears them).
- Server `buildFilter(spec)` (in `server/db/feed.js`, the function that produces
  `{ sql, params }`): when `dateFrom`/`dateTo` are present, append
  `AND COALESCE(photos.taken_at, photos.mtime) >= ?` and/or `<= ?`. Bounds are
  clamped/validated as finite numbers; either may be null (open-ended).
- `parseFilterParam` (server, request → spec) must accept and coerce the two
  new numeric fields.

### 2. Density endpoint — `GET /api/times`

- Query: `filter` (same encoding as `/api/feed`).
- **Strips the time facet** from the incoming spec before querying (so the
  histogram shows the full temporal span you brush *within*), but keeps
  rating/orientation → true crossfilter.
- Returns `{ times: number[], total: number, min: number|null,
  max: number|null, sampled: boolean }` where `times` is the `t` column,
  **even-stride down-sampled** to a cap (`TIMES_SAMPLE_MAX = 12000`) so the KDE
  is cheap regardless of library size. `total` is the true unsampled count;
  `min`/`max` are the exact domain bounds (computed unsampled) so the axis scale
  is correct even when sampled.
- Implemented as a new `workingSetTimes(db, spec, cap)` in `server/db/feed.js`,
  sibling to `workingSetTimeline`.

### 3. `ui/src/lib/api.js`

- `fetchTimes(filter)` → `GET /api/times?filter=…`, returns the JSON above.

### 4. `ui/src/lib/TimelineFilter.svelte`

Presentational wrapper, mounted via a Svelte action (the existing
`groupBySelector`/MultiAutoSelect pattern):

```js
import * as d3 from "d3";
import { zoomableAxisInput } from "@john-guerra/d3-zoomable-axis";

function timeline(node, { min, max, times, value, width }) {
  const scale = d3.scaleTime().domain([new Date(min), new Date(max)]);
  const w = zoomableAxisInput(scale, {
    orient: "bottom", length: width, value, // value: [Date|ms, Date|ms] or full domain
    format: (d) => d3.timeFormat("%b %e, %Y")(new Date(+d)),
    scent: { values: times, type: "violin", style: "kde", colorSelected: "#4c9aff" },
  });
  w.addEventListener("input", () => dispatch("range", w.value.map((d) => +d)));
  node.appendChild(w);
  return { update(next) { /* rebuild on data/width change */ }, destroy() { w.remove(); } };
}
```

- **Props:** `min`, `max`, `times`, `value` ([from,to]|null), and it self-measures
  width via `bind:clientWidth` (same fix as `SnapshotStrip` — manual
  ResizeObserver missed initial layout).
- **Events:** `range` → `[fromMs, toMs]`; a `clear` when the brush is reset to the
  full domain (treated as "no time filter").
- Emits are **debounced ~120 ms** before touching the filter, so dragging doesn't
  fire a feed rebuild per pixel.
- Implementation note / risk: `d3.scaleTime` handles/scent may surface values as
  `Date` vs. number — coerce with `+d` on the way out, pass ms numbers to
  `scent.values`. Verify against the component's `examples/test-local.html`
  during build. If `zoomableAxisInput` can't take a time scale cleanly, fall
  back to a numeric ms domain + a `format` that renders dates (ticks then need
  the core `zoomableAxisBottom(scaleTime)` path).

### 5. `App.svelte` integration

- New state: `let timeDomain = { min: null, max: null }; let timeTimes = [];`
  refetched by an effect keyed on the **non-time** filter facets + `libraryVersion`
  (crossfilter): `$: refreshTimes(rating/orientation-only-spec, libraryVersion)`.
- Render `<TimelineFilter … on:range=… on:clear=… />` in a new always-on strip
  between `<header>` and `.app-body`.
- `on:range` → set `filter.dateFrom/dateTo` and route through the **existing**
  `onFilterChange(next)` (so Display/Select, the count refresh, and the feed
  rebuild all reuse the current path — no new feed-window guard copy, per
  CLAUDE.md's "no 7th copy" rule).
- The current `[dateFrom, dateTo]` flows back into `TimelineFilter`'s `value` so
  the brush reflects programmatic clears (e.g. the ✕ clear-filter button).
- Empty library (`min == null`) → hide the strip.

## Error handling

- `/api/times` filter parse error → 400 (mirrors `/api/feed`).
- `fetchTimes` failure → the strip renders empty/hidden and sets the existing
  `error` line; the feed is unaffected (the timeline is additive).
- Null/invalid brush bounds are ignored (open-ended range).

## Testing

**Unit (vitest, colocated):**
- `buildFilter` emits the `COALESCE(taken_at,mtime) BETWEEN`/`>=`/`<=` clause for
  each of {both bounds, from-only, to-only, neither} and AND-composes with a
  rating facet.
- `parseFilterParam` round-trips `dateFrom`/`dateTo`.
- `workingSetTimes`: respects rating/orientation, **ignores** an incoming time
  facet, returns exact `min`/`max`, and down-samples above the cap while keeping
  `total` exact.
- `filterSpec.isActive` true when either date bound is set.

**Live-verify (browser, per project convention — feed-window/filter changes):**
- Brush a range → feed narrows to it, header "showing" count drops, no duplicate
  ids.
- Zoom (drag handles) refines; the emitted range updates the feed.
- Display vs. Select: Display narrows the feed; Select unions time-matching
  photos into the selection.
- Crossfilter: set rating ≥ 4 → the timeline histogram reshapes (refetch).
- Reset: clear the brush / hit ✕ → `dateFrom/dateTo` clear, feed returns to full.

## Out of scope (future)

- Album-boundary overlay on the timeline (markers where auto-albums split).
- Following the active feed scroll position ("you are here" marker).
- Timeline-as-navigation (click to jump the feed) — this design is filter-only.
