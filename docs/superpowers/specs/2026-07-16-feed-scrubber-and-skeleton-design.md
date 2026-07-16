# Feed sort-aware scrubber + skeleton-in-reserve — design

Date: 2026-07-16
Status: reviewed — decisions locked, ready for implementation plan
Related: issue #132 (fast-fling blank), `docs/feed_data_architecture.md`

## Problem

The feed conveys almost nothing about **how big the library is** or **where you
are in it**. The only orientation aids are the top date-histogram (a value-axis
brush, not a position indicator) and the left Library tree (materialized and
scannable, but a hierarchy browser, not a scroll position). Scrolling a 114k-photo
library, you have no sense of "I'm a third of the way through 2010" and no fast way
to scan to a spot. A hard fling also overshoots the loaded frontier into empty
reserve space and shows a blank void (issue #132).

The user's goal, verbatim: _"something that feels natural scrolling and that conveys
the idea of how big the library is and where I'm in."_ The reference feel is the
tree sidebar — stable, no flicker, scroll-to-end, scannable.

## Goals

1. A **sort-aware scrubber**: a right-edge rail showing the whole library's shape
   for the current sort/grouping, a viewport thumb that tracks scroll, labeled
   landmarks you can scan and click to jump.
2. A **skeleton-in-reserve**: placeholder grid boxes rendered ahead of the loaded
   frontier so a fast fling shows structure instead of void (#132 residual).

Non-goals (YAGNI): mid-session responsive re-layout (user rarely resizes);
per-photo server-side geometry (disproven earlier — client layout stays); a new
identity/hash system; touch-gesture scrubbing (desktop-first).

## Shared foundation: the landmark manifest

Both features read **one** structural dataset: the ordered groups of the current
feed with their counts. This already exists server-side and needs no new query for
the grouped case.

- **Source (grouped feeds):** `GET /api/tree/flat` → `getFlatTree(db, {groupBy,
filter, sort})` returns `{ total, leaves: [{ values: {dim: val, …}, count }] }` —
  one row per finest-level group, ordered in feed order, via a full-set `GROUP BY`
  (`server/db/tree.js:118`). This is exactly a landmark manifest; the fisheye
  sidebar already consumes it (`FisheyeSidebar.svelte:55`).
- **Axis: user-selectable, default cumulative photo count.** Exposed as a setting
  (see below) so it can be A/B'd like the prefetch presets:
  - **By photo count (default):** `y(n) = (n / total) · railHeight`, `n` a
    cumulative count. The thumb tracks scroll — 50% of the rail ≈ 50% through the
    photos; busy groups take proportionally more rail.
  - **By sort value:** `y(v) = ((v − vMin) / (vMax − vMin)) · railHeight`, linear in
    the sort dimension's value space (like the top timeline). Meaningful only for
    **date and numeric** sorts; for categorical/folder grouping (no metric) it
    falls back to the count axis. A sparse decade then still spans its whole range,
    and the thumb no longer moves linearly with scroll.
    The client builds a prefix-sum array over leaf counts regardless (needed for
    landmark placement and the count axis); value-axis additionally reads each
    landmark's boundary sort value.
- **Landmarks (labeled checkpoints):** the **coarsest** grouping dimension's
  distinct values (e.g. years, or top-level folders), derived client-side by
  collapsing the flat leaves on their first `values` dimension. Each landmark
  carries `{ label, startCount, count, jumpPath }` where `jumpPath` is the
  `[{dimension, value}]` array the existing `jumpToPath` consumes. Equal-count
  (quantile) thinning with a minimum-pixel floor decides which labels render when
  there are more landmarks than rail pixels; density (leaf counts) always renders.
- **Caching / morph-don't-blank:** the client keys the manifest by
  `(groupBy, sort, filter)` signature and refetches on change, keeping the previous
  manifest painted until the new one arrives (never blank on a sort/filter change).

### Settings integration

The axis is a persisted preference, following the existing pattern exactly:
`loadSetting`/`saveSetting` (`ui/src/lib/settings.js`, `autogallery.scrubberAxis`,
default `"count"`) and a new control in `SettingsPanel.svelte` — a small
segmented/`select` in a "Scrubber" section: **By photo count (tracks scroll) /
By sort value (date & numeric)**, with a one-line hint that value-axis falls back
to count for folder/categorical grouping. `App.svelte` owns the `scrubberAxis`
state (bindable into the panel, same as `prefetchPreset`/`adaptivePageSize`) and
passes it to `Scrubber.svelte`. Changing it re-renders the rail live off the
already-loaded manifest — no refetch.

### Ungrouped (flat) feeds — second phase

A flat feed (no `groupBy`, sorted by name/size) has no groups, so landmarks must
come from **sort-value quantiles** instead. This needs (a) a thin endpoint that
returns N evenly-spaced sort-value boundaries (`SELECT sortExpr … ORDER BY sortExpr
LIMIT 1 OFFSET k·total/N`, N cheap indexed seeks) and (b) a **start-value** feed
seek (today the feed seeks by `startPath` or `focusId`, not a bare sort value).
Because the default and dominant feeds ARE grouped (folder / date), flat-feed
landmarks are deferred to a follow-up; the scrubber renders a plain proportional
thumb with no landmarks when ungrouped until then.

## Feature 1 — sort-aware scrubber (build first)

### Rendering

A fixed right-edge rail (`ui/src/lib/Scrubber.svelte`, new). Top to bottom:

- **Density track** (conveys "how big"), source depends on the sort:
  - **Date sorts** → the smooth KDE "scent" from `/api/times` (`workingSetTimes`,
    the same down-sampled full-library timestamps the top timeline uses), for finer
    within-group texture. Note it is value-distributed (by time); on the **count
    axis** its samples are re-placed by cumulative count, on the **value axis** it
    maps directly.
  - **Non-date sorts** (folder/camera/kind/rating/size) → manifest leaf-count bars
    at each group's cumulative-count position (no KDE — `/api/times` is date-only).
    Two render paths, one component; the KDE path is skipped whenever the sort isn't
    a date sort.
- **Landmark labels:** the coarse checkpoints, placed at their `startCount`
  position, adapted to type:
  - date-derived dims (year/month/day) → date labels ("2010", "Mar 2010");
  - `folder` → folder name (leaf of the path);
  - `camera`/`kind` → the categorical value;
  - flat numeric/text sort (phase 2) → value ranges / initials ("M–P", "2–4 MB").
- **Viewport thumb:** a bracket spanning the on-screen count range. Position from
  the **top-visible group** — `deriveCurrentPath(renderStart, …)` gives the current
  top group path; map path → manifest group → `startCount` → thumb y. Group
  granularity is enough for v1; within-group interpolation can refine later.

### Interaction

- **Hover:** DOI fisheye magnifies the labels near the cursor (reuse
  `@john-guerra/fisheye-nav`, already a dependency and used by the fisheye sidebar),
  so a dense rail stays scannable. Show the hovered landmark's label + count.
- **Click a landmark → `jumpToPath(landmark.jumpPath)`.** Reuses the existing
  value-seek jump end to end (`App.svelte:1999`) — no new server jump machinery.
- **Drag the thumb:** live scrub. Map drag-y → cumulative count → nearest group →
  `jumpToPath`, throttled to one in-flight jump (respect the feed epoch / fetching
  guards — the scrubber only ever calls the existing guarded jump, never touches
  `items`/`feedEpoch` itself). Show a floating preview label while dragging.
- **Keyboard:** `[` / `]` hop to the previous/next landmark. These map onto the
  existing `jumpGroupBoundary(direction)` (`App.svelte:4610`) at the coarse-group
  level. Documented in `ShortcutsOverlay.svelte` in the same commit (Navigation
  group), per the keyboard-shortcut rule.

### Pure, testable core

Extract the position math into a framework-free module
(`ui/src/lib/scrubber/scale.js` + colocated vitest): `buildManifest(leaves)` →
prefix sums + coarse landmarks; a single `axisScale(axis, manifest, railH)` that
returns `toY(landmark)` / `fromY(y)` for either `"count"` (cumulative-count) or
`"value"` (sort-value, with the categorical→count fallback baked in);
`thinLandmarks(landmarks, railH, minGapPx)` (quantile thinning with floor);
`thumbSpan(topCount, viewportCount, total, railH)`. The Svelte component is a thin
renderer over these, and the axis choice is a prop. Both axes are unit-tested,
including the value→count fallback for categorical grouping. e2e (Playwright) covers the DOM/scroll seam: load a grouped
feed, assert the thumb sits where the top-visible group says, click a landmark and
assert the feed re-anchors to it, all under `trackPageErrors`.

## Feature 2 — skeleton-in-reserve (build second)

The manifest's `total` and cumulative counts give a **real total-content-height
estimate** for the whole library (loaded density × remaining count), replacing the
`BOTTOM_RESERVE_PX = 3000` heuristic (2.16.6/2.16.7) with an honest full-height
scroller. In the region below the loaded frontier, the grid emits **lightweight
placeholder boxes** — the diagonal-stripe tiles, uniform placeholder aspect, **no
thumbnail fetches** — laid out by a simplified justified pass over the manifest
counts. A fast fling then lands on grid _structure_ (and the coarse group headers,
positioned from the manifest) instead of void, closing #132's residual.

This also makes the scrubber's count-axis exact (scroll position ∝ global count,
not just loaded count) — the two features reinforce each other. Because it changes
the scroller height and the layout's below-frontier region, it ships after the
scrubber and gets its own live-verification pass against the #132 fling repro.

## Staging (commits)

1. **Manifest client + scale module** (pure, unit-tested). Fetch/cache
   `/api/tree/flat`, build prefix sums + coarse landmarks. No UI yet.
2. **Scrubber component** — density + landmarks + static thumb (position only),
   count axis only.
3. **Axis setting** — `scrubberAxis` in `settings.js` + `SettingsPanel.svelte`
   control + the value-axis scale; live-toggle between the two.
4. **Scrubber interaction** — hover fisheye, click-jump, drag-scrub, `[`/`]` keys
   (+ ShortcutsOverlay). Live-verify.
5. **Skeleton-in-reserve** — manifest-driven full height + placeholder fill; retire
   the reserve hack; live-verify against #132.

Each stage is a version bump + CHANGELOG line + green tests, committed at the green
state, per the commit-often rule.

## Risks / watch-items (from grounding)

- **Folder sort/identity split** (`feed.js:53-85`): folder landmarks must order in
  the `sort_path` key space, not `abs_path`, or they splice into the wrong slot.
- **Expression-index fingerprinting** (`sort.js:149-218`): the manifest reuses
  `getFlatTree`, which already uses the canonical exprs — do not introduce new date
  exprs, or SQLite silently drops the index and the feed regresses to full scans.
- **Feed-window guards** (issues #35/#36/#39/#42): the scrubber must navigate
  ONLY through `jumpToPath`/`recenterFeedOnId`; it never mutates `items`/`feedEpoch`
  or hand-rolls a fetch guard.
- **Two "timeline" functions** exist with near-identical names — density for date
  sorts is `workingSetTimes` (`/api/times`), not `workingSetTimeline`.

## Decisions (resolved in review)

1. **Axis:** user-selectable Settings toggle, default **count** (value-axis
   available for date/numeric sorts, falls back to count for categorical/folder).
2. **Density:** **KDE scent from `/api/times` for date sorts**; manifest leaf-count
   bars for non-date sorts.
3. **Thumb:** **group granularity** for v1 (snap to top-visible group's cumulative
   start); within-group interpolation is a later refinement.
4. **Build order:** scrubber first, skeleton-in-reserve second.
5. **Scope out of v1:** ungrouped/flat-feed sort-value landmarks (follow-up);
   touch-gesture scrubbing (desktop-first).
