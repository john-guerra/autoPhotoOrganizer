# Timeline date filter + month-of-year grouping — design

## Context

AutoGallery filters the working set by rating, orientation, and a "keep only"
scope — all compiled through one `buildFilter(spec)` (`server/db/filters.js`) and
threaded to the grid, tree, fisheye, counts, and auto-albums via a single
`displayFilter` derived value in `App.svelte`. There is **no way to filter by
date**, and no view of *when* the displayed photos actually fall in time.

For a photographer culling thousands of trip photos, "show me just December
2019" and "where do my photos cluster over the years" are core questions. This
adds a **date-range filter driven by a timeline visualization**: a compact
sparkline living beside the existing filters, expanding to a larger streamgraph
popup with a draggable range brush and manual from/to date entry.

Bundled in, because it shares the date-dimension plumbing: **month grouping
becomes month-of-year** — grouping by `month` collapses all Decembers (2002,
2003, …) into a single "December" group, instead of today's per-`YYYY-MM`
buckets labeled `2002-12`.

### Decisions locked with John (brainstorm)

- **Two sizes, one data source.** A toolbar **sparkline** (single volume band)
  and a **popup** (larger, stacked streamgraph). The sparkline sits next to the
  rating/orientation filters.
- **Popup stacks by the current `groupBy`** dimension, colored with a **d3 turbo
  scale**. (A streamgraph needs a stacking category to be more than an area
  chart; turbo earns its keep across many ordered bands.)
- **Manual entry + brush.** Two native date inputs for exact from/to, kept in
  sync with a d3 `brushX` drag-select over the chart.
- **Month grouping aggregates across years** (`strftime('%m')` → "December"),
  labeled with month names. Ordered **DESC to match the other date dimensions**,
  and — new — the group **order dimension and direction are user-controllable**
  (see "Group ordering control" below), so month asc-vs-desc becomes a toggle
  rather than a baked-in choice.
- **Configurable series cap.** The stack's top-N cap is a user-adjustable value
  (like the albums "Max"); everything past it rolls into an **"Others"** band.
- **Undated photos** (`taken_at` NULL) surface as a **selectable "Unknown"**
  segment: visible in the chart, and clicking it filters the working set *to*
  the undated photos (needs an `undated` filter flag — see below).
- **Svelte 4, not 5.** The repo is pinned to `svelte@4`; the new timeline
  components use Svelte 4 idioms (`export let`, `$:`, `createEventDispatcher`) to
  match every existing component. A whole-app migration to Svelte 5 runes is
  deferred to its own issue (see below) — no mixed reactivity models.

## Goals

1. Add `dateFrom` / `dateTo` / `undated` to the filter spec so a date range (or
   "undated only") narrows the grid, tree, fisheye, counts, and auto-albums — all
   in agreement, for free.
2. A toolbar **sparkline** showing the time distribution of the *displayed* set.
3. A **popup streamgraph** with brush + manual date entry + a stack-by selector +
   configurable series cap + a selectable "Unknown" (undated) segment.
4. Redefine the `month` grouping dimension to month-of-year with month-name
   labels.
5. A **group ordering control** — pick the order dimension (a groupBy dim or
   `count`) and direction (asc/desc).

## Non-goals (this slice)

- Not virtualizing or infinite-zooming the timeline; adaptive fixed buckets only.
- Not a d3 album-boundary timeline (that remains a separate deferred issue).
- Not multi-level ordering: the order control reorders one (outer) group level,
  not an independent sort per nested level.

---

## Architecture

### 1. Filter spec: `dateFrom` / `dateTo`

`buildFilter(spec)` gains a fourth clause. `photos.taken_at` is stored as **epoch
milliseconds** (confirmed by the existing `strftime('%Y', photos.taken_at / 1000,
'unixepoch')` dimension exprs), so the bounds are epoch-ms integers:

```js
// from inclusive, to exclusive — the client sets `dateTo` to the start of the
// day *after* the picked end date, so a "Dec 1 – Dec 31" pick includes all of
// Dec 31. NULL taken_at fails `>= dateFrom`, so undated photos are excluded
// whenever a range is active (they cannot sit on a time axis).
if (spec.undated) {
  // "Unknown" mode: only undated photos. Mutually exclusive with a range —
  // when set, dateFrom/dateTo are ignored.
  clauses.push("photos.taken_at IS NULL");
} else {
  if (Number.isFinite(dateFrom)) { clauses.push("photos.taken_at >= ?"); params.push(dateFrom); }
  if (Number.isFinite(dateTo))   { clauses.push("photos.taken_at <  ?"); params.push(dateTo); }
}
```

Injection-safe (bound params, numeric-validated). Each field is optional
(open-ended ranges allowed). `undated: true` is how the selectable "Unknown"
segment becomes an actual filter — the date range can't express "has no date."

- **Client** `ui/src/lib/filterSpec.js`: `isActive` and `toQueryParam` handle the
  two numeric fields **and** the boolean `undated` (round-trip through the query
  string).
- **Server** `parseFilterParam` (`server/api.js`): validate the dates are
  integers and `dateFrom <= dateTo` when both present (else 400); coerce
  `undated` to a strict boolean. Matches the existing scopeIds-validation shape.

### 2. Histogram aggregation endpoint

The chart needs *bucketed counts*, a different shape from the existing
`workingSetTimeline` (which returns up to N individual photos for albums). New:

```
GET /api/photos/histogram?filter=<spec>&stackBy=<dim|none>&bucket=<year|month|day|auto>&maxSeries=<n>
```

Response:

```jsonc
{
  "bucket": "month",                 // resolved unit (echoes the auto choice)
  "stackBy": "camera",               // resolved stacking dimension, or null
  "series": ["Canon EOS", "Pixel 7", "…", "Others"], // ordered series keys
  "buckets": [                       // time-ascending
    { "t": 1575158400000, "counts": { "Canon EOS": 3, "Pixel 7": 5 }, "total": 8 }
  ],
  "unknown": 42,                     // count of NULL taken_at (no time position)
  "total": 12048,
  "range": { "from": 1039564800000, "to": 1734048000000 }  // min/max taken_at
}
```

Implementation (`server/db/histogram.js`, one query + a JS reshape):

- `bucketExpr` = `strftime('%Y'|'%Y-%m'|'%Y-%m-%d', taken_at/1000,'unixepoch')`.
- `SELECT bucketExpr AS b, <stackByExpr> AS s, COUNT(*) AS n FROM photos JOIN
  folders … WHERE stale=0 AND (filter.sql) AND taken_at IS NOT NULL GROUP BY b,s`.
- Undated count: a second one-row `COUNT(*) … WHERE taken_at IS NULL AND
  (filter.sql)`.
- Reshape rows → `buckets[]`, converting each bucket label back to an epoch-ms
  `t` (start of the period) via `d3.timeParse` on the server? No — server has no
  d3; parse the `YYYY[-MM[-DD]]` label to a UTC epoch with `Date.UTC`, matching
  the `'unixepoch'` (UTC) the SQL used. Keep it framework-free like `albums/`.
- **`stackBy` reuses `DIMENSIONS[dim].expr`** — same dimension registry the feed
  and tree already validate against. `none` (or an unknown/absent value) → a
  single `"All"` series.
- **Configurable top-N cap.** High-cardinality stack dimensions (folder =
  hundreds) would emit hundreds of bands — unreadable and slow. Keep the **top
  `maxSeries` series** by total count (query param, **default 20**, validated to
  `[1, 100]`); roll the rest into an **`"Others"`** band. The `"Others"` key's
  presence in `series[]` tells the client rollup happened. The popup exposes
  `maxSeries` as a small number input (same pattern as the albums "Max"), echoed
  back in the response.

**Adaptive bucket** (`bucket=auto`, the default) — pure helper
`ui/src/lib/histogram.js#pickBucket(spanMs)` used client-side to request, and
mirrored server-side as the fallback when `bucket` is omitted:

| span of the filtered set | bucket |
| --- | --- |
| > ~5 years | `year` |
| ~4 months – 5 years | `month` |
| < ~4 months | `day` |

Thresholds are named constants; the resolved unit is echoed in the response so
the axis labels itself correctly.

### 3. What the chart reflects — the range is an *overlay*, not a filter of itself

Both the sparkline and popup show the distribution of the displayed set **with
its own date bounds stripped**: they query `displayFilter` **minus** `dateFrom`/
`dateTo`, then render the currently-selected `[from, to]` as a highlighted
region / brush selection on top. This avoids the circularity of "the chart only
shows the range the chart selected," and matches the standard brush-over-full-
distribution idiom. Rating/orientation/keep-only scope **do** apply (they define
"displayed").

### 4. Components

All new UI is small and single-purpose, communicating through props + events;
App.svelte owns the filter state and wiring.

- **`ui/src/lib/histogram.js`** (pure, no DOM): `pickBucket(spanMs)`, plus a
  `assignTurbo(seriesKeys)` helper mapping an ordered series list to turbo colors
  (`d3.interpolateTurbo` over `[0,1]`). Unit-tested.
- **`ui/src/lib/TimelineSparkline.svelte`**: ~140×30px inline SVG area of bucket
  totals (single band), turbo-tinted along the time axis, with the active range
  shaded. Fetches the histogram (no `stackBy`) whenever the date-stripped
  `displayFilter` changes. Emits `open` on click. Shows a subtle "×" to clear the
  date filter when one is active. Lives in the toolbar's filter cluster, right
  after `OrientationFilter`.
- **`ui/src/lib/TimelinePopup.svelte`**: the larger view. `d3.scaleTime` X,
  `d3.stack` + `d3.area` bands (`d3.scaleLinear` Y), turbo ordinal fill,
  `d3.axisBottom` ticks. A `d3.brushX` drag selects a range; two
  `<input type="date">` (from/to) sync **bidirectionally** with the brush. A
  `stack by ▾` `<select>` (dimension list; defaults to the current `groupBy[0]`,
  or `none`) and a **`Max series`** number input (`maxSeries`). The **"Unknown"**
  segment renders as a separate labeled bar set off to the left of the time axis
  by a gap (it has no date, so it is not stacked across time); **clicking it
  selects undated-only** (`filter.undated = true`) and it shows a selected state
  while active. Footer: **Apply** (emit the `[from, to]`), **Clear**, **Close**.
- **`ui/src/App.svelte`**: fold `dateFrom`/`dateTo`/`undated` into
  `filter`/`displayFilter`; render the sparkline; own `timelineOpen`; handle
  apply/clear (writes the bounds, which flow everywhere through `displayFilter`),
  and stack-by defaulting from the current `groupBy`.

- **`ui/src/lib/api.js`**: `fetchHistogram(filter, { stackBy, bucket, maxSeries })`.

### 5. Month-of-year grouping

Redefine the `month` dimension in `server/db/feed.js`:

```js
// was: strftime('%Y-%m', …) → "2002-12"
month: { expr: "COALESCE(strftime('%m', photos.taken_at/1000,'unixepoch'), '')",
         direction: "DESC" },  // "01".."12"; matches the other date dims. The
                               // per-dimension `direction` is now only the
                               // *default* — overridable at query time (below).
```

- Full chronological month is still reachable via `groupBy: [year, month]` → 2003
  › January … December, 2002 › January … December. `groupBy: [month]` alone gives
  the "all my Decembers" view. `day` is unchanged (`%Y-%m-%d`); a full date
  hierarchy is `[year, month, day]`.
- **Label**: a shared `MONTH_NAMES` map turns `"12"` → `"December"`. Applied in
  **`formatGroupValue`** (`ui/src/lib/feed.js`) and mirrored in
  **`formatTreeLabel`** (`server/db/tree.js`) — these are already documented as
  hand-synced twins. `""` still → `"Unknown"`.

### 6. Group ordering control (order dimension + direction)

Today each `DIMENSIONS[dim].direction` is fixed and groups sort by the groupBy
dimensions in sequence. This adds a UI-controllable **order dimension** and
**direction**, so (e.g.) months can flip asc/desc, or albums can sort by size
instead of date, without code changes.

- **Query params** on the feed/tree/fisheye calls: `orderBy` and `orderDir`.
  - `orderBy` ∈ the active `groupBy` dimensions **or** `count` (photos per
    group). Absent → today's behavior (each dim's default direction, in groupBy
    order).
  - `orderDir` ∈ `asc` | `desc`. Absent → the dimension's default `direction`.
- **Semantics.** `orderBy` reorders the **outermost** group level (the one that
  visually reorders the feed); inner levels keep their default order. `count`
  orders groups by their photo count (needs the count already computed in the
  grouping query — the tree/fisheye have it; the feed's group seek would compute
  it per outer group). This is the one piece with real reach into the feed
  ordering SQL, so it is built and verified on its **own checkpoint** and, if it
  grows, split into its own plan (it is orthogonal to the timeline viz — they
  only meet at "month order").
- **UI.** A small `order by ▾ [dim|count]  ⇅ [asc|desc]` control in the toolbar's
  organize cluster (near group-by). Persisted in localStorage like other view
  prefs.
- **Validation** (`server`): `orderBy` must be one of the current groupBy dims or
  `count`; `orderDir` ∈ {asc,desc}; otherwise ignored (fall back to defaults) —
  a display nicety, never a 400.

> Scope note: items 1–5 are the timeline + month feature. Item 6 is a closely
> related but separable enhancement John asked for in the same breath ("change
> the order dimension and direction too"). It is speced here for coherence; at
> planning time it may become a sibling plan if the feed-ordering work is larger
> than a single checkpoint.

---

## Data flow

```
User drags brush / types dates in TimelinePopup   (or clicks the Unknown bar)
      → emits { from, to }  (or { undated: true }) → App sets filter.dateFrom/dateTo/undated
      → displayFilter recomputes
      → grid, tree, fisheye, counts, albums all re-query  (existing plumbing)
      → sparkline + popup re-query histogram (date bounds STRIPPED) and redraw the overlay
```

Grouping and ordering are orthogonal to the filter: the redefined `month` expr
changes how the feed/tree/fisheye bucket + label groups, and `orderBy`/`orderDir`
change how they sort — neither interacts with `dateFrom`/`dateTo`/`undated`.

## Error handling

- Invalid `dateFrom`/`dateTo` (non-integer, or from > to) → **400** from
  `parseFilterParam`, consistent with existing filter validation.
- Unknown `stackBy` dimension → treated as `none` (single "All" series), not an
  error. This deliberately differs from the feed (which *throws* on an unknown
  groupBy dimension): `stackBy` is a display nicety, so a stale/unknown value
  should degrade to a plain area rather than break the chart.
- Empty result set → `buckets: []`, `total: 0`; the sparkline renders an empty
  baseline, the popup shows an "empty" message; no crash.
- Undated-only set → `buckets: []` with `unknown > 0`; the popup shows just the
  Unknown bar.
- Invalid `maxSeries` (non-integer / out of `[1,100]`) → clamped to the default,
  not a 400. Invalid `orderBy`/`orderDir` → ignored, defaults used.
- `undated: true` **and** a date range both set → `undated` wins (range ignored),
  as coded in `buildFilter`; the UI never sets both (selecting Unknown clears the
  range and vice-versa).

## Testing

**Unit (vitest, colocated):**
- `buildFilter` date clauses: from-only, to-only, both, from>to rejected upstream,
  NULL `taken_at` excluded when a bound is set; `undated:true` → only NULL
  `taken_at`, and it overrides a range. (`filters.test.js`)
- `histogram.js` pure helpers: `pickBucket` thresholds at the boundaries;
  `assignTurbo` stable ordering. (`histogram.test.js`)
- Histogram endpoint (`api.test.js`): bucketing by year/month/day; `stackBy`
  splits into series; **configurable `maxSeries`** + "Others" rollup past the cap
  (and clamp of an out-of-range `maxSeries`); `unknown` counts NULL `taken_at`;
  `bucket=auto` resolves per span; adaptive fallback server-side.
- Ordering: `orderBy`/`orderDir` reorder the outer group level; `orderBy=count`
  sorts by group size; invalid values fall back to defaults. (`feed.test.js` /
  `tree.test.js`)
- Month-of-year: dimension expr yields "01".."12"; `formatGroupValue` /
  `formatTreeLabel` both map "12"→"December" and ""→"Unknown" (twin-sync guard).
- `filterSpec.js`: `isActive`/`toQueryParam` round-trip `dateFrom`/`dateTo`/`undated`.

**Live (per the App.svelte manual-verify convention — feed-window/filter changes
aren't "done" on a green suite alone):**
- Sparkline renders the displayed distribution; opening the popup shows the
  streamgraph stacked by the current groupBy, turbo-colored, with an Unknown bar.
- Brush a range → the from/to inputs update; typing dates moves the brush; Apply
  narrows the grid **and** the library/showing counts **and** the tree/fisheye
  **and** an auto-albums detect; Clear restores.
- Switch `stack by` → bands recompute; change `Max series` → rollup into "Others"
  recomputes.
- Click the **Unknown** bar → grid + counts show only undated photos; it shows a
  selected state; clicking again (or Clear) restores.
- Group by `month` alone → month-name headers, all years merged; `[year, month]`
  → chronological.
- `order by ▾` + direction toggle → the outer group level reorders (by dimension
  value or by count, asc/desc), verified live in feed + tree.

---

## Build order (checkpoints)

1. `buildFilter` + `parseFilterParam` for `dateFrom`/`dateTo`/`undated` +
   `filterSpec.js` + unit tests. (Filter works via hand-set query params; no UI
   yet.) **Commit.**
2. `server/db/histogram.js` + `/api/photos/histogram` (with `stackBy`, `bucket`,
   configurable `maxSeries`, "Others", `unknown`) + `histogram.js` pure helpers +
   tests. Verify via `curl`. **Commit.**
3. Month-of-year dimension + label twins + tests + live-verify grouping. **Commit.**
4. **Group ordering** (`orderBy`/`orderDir` in feed/tree + toolbar control) +
   tests + live-verify. Its own checkpoint because it reaches the feed-ordering
   SQL; promote to a sibling plan if it outgrows one commit. **Commit.**
5. `TimelineSparkline` in the toolbar (single band, click to open). **Commit.**
6. `TimelinePopup` (streamgraph + brush + date inputs + stack-by + `Max series` +
   selectable Unknown) wired to the filter; full live-verify. **Commit.**

Each step builds, tests pass, and a slice works before the next — per the
project's commit-often checkpoint discipline.

## Resolved in review

1. **Month order** — **match the other date dims (DESC)**, and the order
   dimension + direction are made user-configurable (§6) so it is no longer a
   baked-in choice.
2. **Series cap** — **configurable** (`maxSeries`, default 20), rest → **"Others"**.
3. **Unknown** — a **selectable** segment: visible, and clicking it filters to the
   undated photos (`filter.undated`).

## Deferred / follow-up issues (not built here)

- d3 album-boundary timeline (existing separate ask).
- Timeline zoom / drill from year→month→day by clicking a bucket.
- Independent sort per nested group level (this slice orders one outer level).
- **Migrate the whole app to Svelte 5 runes** (`$state`/`$derived`/`$props`,
  callback props). One-pass migration via `svelte-migrate`, then live-verify —
  its own issue, decided after this feature lands.
