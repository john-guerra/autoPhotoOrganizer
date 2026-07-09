# Feed sort — global photo-level sort attribute + direction

## Context

The feed has **no photo-level sort today.** `getFeedPage` orders by a keyset
**seek tuple** `seekDims = [...groupBy dimensions, photos.id ASC]`
(`server/db/feed.js:329`). So within a leaf group photos are ordered by
`photos.id` — scan/discovery order — and the "newest first" a user perceives is
purely a **side effect of grouping by date dimensions** (year/month/day). Group
by folder instead and the photos inside are in id order, not date order.

John wants a real **global sort**: choose an attribute (date, rating, size, …)
and a direction, and have it order the actual feed — within groups when grouping
is on, and across the whole flat stream when it is off. And "sort the groups" is
the *same* intent one level up.

This is foundational and orthogonal to the timeline-date-filter feature, so it is
its own spec. (The timeline spec sets the `month` dimension's *default* direction;
this spec is what makes date order adjustable.)

### Decisions locked with John (brainstorm)

- **Model:** the sort is one extra column in the existing seek tuple, between the
  group dimensions and the `id` tiebreak — so grouped-within, flat-whole, and all
  pagination/seek keep working for free.
- **Attributes (v1):** three **dates** — EXIF/taken, creation, modified —
  plus rating, file size (bytes; "MB" is just the display unit, ordering is
  identical), and filename. Each with an asc/desc direction. (Camera/orientation
  and a random "shuffle" are deferred.)
- **Creation date needs a new column.** The schema stores `mtime` (modified) and
  `taken_at` (EXIF) but **not** file creation time. Add a `btime` column, captured
  from the *same* `stat()` the scanner already calls (`st.birthtimeMs` — free, no
  extra I/O), backfilled on the next rescan.
- **Grouping follows the sort's date source.** The year/month/day dimensions
  re-derive their *column* (taken / created / modified) and *direction* from the
  current date sort, so buckets, group order, photo order, and the sidebar all
  agree on one date. Non-date sorts leave the date dims at their default
  (taken, DESC) and only reorder photos within groups. Ordering groups by an
  aggregate of a *non-grouped* attribute (folders by newest photo / by count) is
  deferred.

## Goals

1. A `sort: { by, dir }` spec threaded into `getFeedPage`'s seek tuple → orders
   photos within leaf groups, and orders the whole feed when `groupBy` is empty.
2. Sortable attributes: **date_taken, date_created, date_modified, rating, size,
   name**, each asc/desc.
3. A toolbar **sort control** (attribute + direction), persisted.
4. **Date-sort ↔ date-dimension coupling:** the year/month/day group dimensions
   (feed *and* tree/fisheye sidebars) re-derive their date **column and direction**
   from the current date sort — so grouping by month while sorting by creation date
   buckets by *creation* month, and month asc/desc is just the sort direction.

## Non-goals (this slice)

- Aggregate group ordering (order folders by newest photo, by count, by max
  rating) — deferred; needs per-group aggregation in the grouping query + seek.
- Random / shuffle sort — deferred; true random breaks keyset pagination unless
  seeded, which is separate work.
- Camera / orientation / megapixels sort attributes — not in the v1 set.
- Making the **date filter / timeline / albums** honor the taken-vs-created-vs-
  modified choice — grouping *does* follow the sort's date source (§3), but the
  filter/timeline/albums keep using `taken_at` in v1.
- Independent sort per nested group level.

---

## Architecture

### 0. Schema & scan: capture creation date (`btime`) — prerequisite

- **Schema** (`server/db/schema.js`): add `btime INTEGER` to `photos` (nullable —
  existing rows and filesystems without a reliable birthtime stay NULL).
- **Scanner** (`NodeProcessingService.scan`): the loop already does
  `const st = await stat(path)`; add `btimeMs: st.birthtimeMs` to each file
  record (no extra syscall). `ProcessingService` JSDoc updated to document it.
- **Persistence** (`upsertScan`, `server/db/photos.js`): add `btime` to the INSERT
  and the `ON CONFLICT DO UPDATE SET`. Because the upsert re-writes every scanned
  file (only `content_hash` is conditionally preserved), **`btime` backfills on
  the next scan of each folder** — no separate migration. Until a folder is
  rescanned its photos have `btime = NULL`, and `date_created` falls back to
  `mtime` (below).
- Note: `birthtimeMs` is reliable on macOS/APFS (John's platform); on filesystems
  that don't record it, it can be `0`/`mtime` — the fallback covers that.

### 1. Sortable-attribute registry

A small map beside `DIMENSIONS` (`server/db/feed.js`, or a new
`server/db/sortAttrs.js`), each entry a **null-safe, deterministic** SQL expr —
determinism only needs to be *total together with the `id` tiebreak*, so ties are
fine. The three dates each fall back to `mtime` so undated/unbackfilled rows still
sort sensibly:

```js
export const SORT_ATTRS = {
  date_taken:    { expr: "COALESCE(photos.taken_at, photos.mtime)" }, // EXIF, fallback modified
  date_created:  { expr: "COALESCE(photos.btime, photos.mtime)" },    // creation, fallback modified
  date_modified: { expr: "photos.mtime" },
  rating:        { expr: "photos.rating" },                  // 0..5, NOT NULL default 0
  size:          { expr: "photos.size" },                    // bytes (= MB ordering), NOT NULL
  name:          { expr: "photos.filename COLLATE NOCASE" }, // case-insensitive (confirmed)
};
```

`by` defaults to **`date_taken`**, `dir` defaults to **`desc`** (see Open
Questions — this changes within-*folder* order from scan-order to date-desc).

### 2. Photo-level sort in `getFeedPage`

Insert the sort as a seek dim **between the group dims and the `id` tiebreak**:

```js
// today:  [ ...dims , {__id: photos.id ASC} ]
// sorted: [ ...dims , {__sort: SORT_ATTRS[by].expr, dir} , {__id: photos.id ASC} ]
const sortDim = { name: "__sort", expr: SORT_ATTRS[by].expr, direction: dir.toUpperCase() };
const seekDims = [...dims, sortDim, { name: "__id", expr: "photos.id", direction: "ASC" }];
```

Everything the tuple drives then generalizes automatically:

- **`seekCondition`** (feed.js:94) already builds keyset conditions from any
  `seekDims` + parallel `focusValues`. The focus row's SELECT gains
  `SORT_ATTRS[by].expr AS sortval`, and `focusValues` becomes
  `[...dimValues, sortval, id]`. No change to the seek algorithm itself.
- **`orderCols`** (feed.js:385) generalizes: group dims → their `dim{i}` alias,
  the sort dim → a selected `sortval` alias, `id` → `photos.id`. The existing
  "before"-page direction flip applies to the sort dim like any other.
- **Empty `groupBy`** (already supported — the group-by widget can remove all
  levels) → `seekDims = [sortDim, {id}]` → the whole feed is sorted by the
  attribute. This is the pure "sort my library by rating" case.
- **Placeholders / collapsed groups are unaffected.** They live at *group*
  granularity; the sort dim sits *below* the deepest group dim, so collapsed-group
  summaries and `compareKeyTuples` (which compares group-key tuples only) do not
  change. Sort only refines leaf-photo order and the flat feed.
- **Redundant-with-a-date-group is harmless & useful:** sorting by date while
  grouped by `day` refines within-day order by exact timestamp.

`startPathCondition` (jump-to-tree-node) still seeks to a *group* position on the
group dims; the after-fetch orders within by the full `seekDims` including the
sort. No change.

### 3. Date-sort ↔ date-dimension direction coupling

**The date group dimensions use the same date source as the sort** (John: "the
group-by time attributes should match the sorting one used"). So year/month/day
are not hardwired to `taken_at` — they re-derive their column *and* direction from
the current date sort.

```js
// One place defines each date source's SQL expr; the three date sort attributes
// and the date group dimensions both read from it.
export const DATE_SOURCES = {
  date_taken:    "COALESCE(photos.taken_at, photos.mtime)",
  date_created:  "COALESCE(photos.btime, photos.mtime)",
  date_modified: "photos.mtime",
};

// The effective date source for grouping = the sort's source when sorting by a
// date, else the default (taken). year/month/day exprs are built from it.
function effectiveDateSource(sort) {
  return DATE_SOURCES[sort?.by] ?? DATE_SOURCES.date_taken;
}
function dateDimExpr(unit, srcExpr) {
  const fmt = { year: "%Y", month: "%m", day: "%Y-%m-%d" }[unit]; // month = month-of-year (timeline spec)
  return `COALESCE(strftime('${fmt}', (${srcExpr}) / 1000, 'unixepoch'), '')`;
}

/** Rebuild the date dims' expr (which date column) + direction (asc/desc) from the sort. */
export function applySortToDims(dims, sort) {
  const src = effectiveDateSource(sort);
  const dateDir = DATE_SOURCES[sort?.by] ? sort.dir.toUpperCase() : "DESC";
  return dims.map((d) =>
    ["year", "month", "day"].includes(d.name)
      ? { ...d, expr: dateDimExpr(d.name, src), direction: dateDir }
      : d
  );
}
```

Applied **wherever group order is resolved**, so the buckets, their order, the
photo order, and the sidebar all agree on one date notion:

- `getFeedPage` and `findGroupBoundary` (feed.js) — feed + next/prev-group nav.
- `getTreeNode` and `getFlatTree` (`server/db/tree.js`) — the tree sidebar and the
  fisheye navigator.

So: group by `month`, sort `date_created` ascending → both the sidebar and the
feed bucket photos by **creation** month and read January → December. Switch the
sort to `date_modified` desc → the same groups re-form by modified date, newest
first. Non-date sorts (rating, size, name) leave the date dims at their default
(taken, DESC) and only reorder photos *within* leaf groups.

> **Composes with the timeline spec.** That spec redefines `month` as month-of-
> year (`strftime('%m', …)`); here the `…` becomes `effectiveDateSource(sort)`
> instead of a hardcoded `taken_at`. Whichever lands second wires the date-source
> into the same `year/month/day` exprs — they are the single seam both specs
> touch. The **date filter/timeline still queries `taken_at`** (its own spec); a
> future unification of the filter's date source is noted there.

### 4. Server: parse & validate

`server/api.js` reads a `sort` query param on the feed, boundary, tree, and
flat-tree endpoints — `by:dir` (e.g. `rating:asc`) or a small JSON object. Coerce:
`by` must be a `SORT_ATTRS` key (else `date_taken`), `dir` ∈ {asc,desc} (else `desc`).
Invalid → default, **not a 400** — sort is a display nicety, and defaulting keeps
the feed rendering. (The count/ids endpoints are order-independent and take no
`sort`.)

### 5. Client

- **State:** `sort = { by, dir }` in `App.svelte`, persisted in localStorage
  (`autogallery.sort`), defaulting to `{ by: "date_taken", dir: "desc" }`.
- **Threading:** pass `sort` through `fetchFeed`, `fetchGroupBoundary`,
  `fetchTreeNode`, `fetchFlatTree` (`ui/src/lib/api.js` serializes it to the query
  string). It joins the existing `displayFilter`/`groupBy` recompute path, so any
  change re-pulls the feed + sidebars.
- **Control:** a compact `sort by ▾ [taken|created|modified|rating|size|name]  ⇅`
  in the toolbar's organize cluster (near group-by). The `⇅` toggles asc/desc. Same
  inline-button styling as the existing toolbar widgets.

---

## Data flow

```
User picks sort attribute / flips direction
   → App sets sort = { by, dir } (persisted)
   → fetchFeed / boundary / tree / flatTree all re-query with `sort`
   → getFeedPage inserts the sort dim into the seek tuple  → photos reorder
   → applySortToDims couples date-sort to year/month/day    → groups + sidebar reorder
```

Filter and grouping are orthogonal: sort changes only *order*, never *membership*
(counts/ids are untouched).

## Error handling

- Unknown `by` / bad `dir` → coerced to defaults, never a 400.
- NULL-bearing attributes sort deterministically via the registry's null-safe
  exprs (no EXIF/creation → `mtime`; missing rating → 0); the
  `id` tiebreak guarantees a total order so pagination never loops or skips.
- Changing sort mid-scroll re-pulls from the current focus (the existing
  `feedEpoch`/`focusId` re-centering path); no bespoke guard added.

## Testing

**Unit (vitest, colocated):**
- `getFeedPage` sort (`feed.test.js`): each attribute asc & desc orders photos
  within a leaf group; **empty groupBy** → whole feed sorted; a non-date sort
  leaves group order unchanged but reorders within; `before`/`after` paging around
  a focus is stable and gap-free under a non-default sort; NULL attributes land
  predictably.
- `applySortToDims` (`feed.test.js`): each date sort rewrites year/month/day to
  its source column (taken/created/modified) + direction; a non-date sort leaves
  them at the default (taken, DESC); unknown `by` → default. A photo whose
  created-month ≠ taken-month lands in the expected bucket per the active sort.
- Coupling reaches the tree: `getFlatTree`/`getTreeNode` bucket + order by the
  sort's date source (`tree.test.js`).
- Param parse (`api.test.js`): `sort=rating:asc` honored; garbage → date_taken:desc.
- `btime` capture + backfill: a scan writes `btime`; a rescan of an existing
  folder backfills a previously-NULL `btime`; `date_created` falls back to `mtime`
  when NULL. (`photos.test.js` / `api.test.js`)

**Live (App.svelte manual-verify convention):**
- Flat feed (remove all group levels) → sort by rating desc, size desc, name asc,
  each of the three dates each reorder the grid correctly; direction toggle reverses.
- Group by folder, sort by rating → photos reorder *within* each folder; folder
  order unchanged.
- Group by month, sort `date_taken` asc vs desc → **both the month headers and the
  sidebar** flip Jan↔Dec; the feed photos within follow.
- Group by month, switch sort taken → created → modified → the buckets re-form by
  that date source (a photo copied/edited in a different month moves groups).
- Sort persists across reload; seek/focus (arrow nav, group jump) stays correct.

---

## Build order (checkpoints)

1. **`btime` column + scanner capture + `upsertScan` persistence** + tests
   (capture, rescan-backfill). Rescan a test folder; `curl` to confirm. **Commit.**
2. `SORT_ATTRS` registry + `getFeedPage` seek-tuple sort dim + `sort` param parse
   + unit tests (within-group, flat, pagination-stable). Verify via `curl`.
   **Commit.**
3. `applySortToDims` coupling across feed / boundary / tree / flat-tree + tests +
   live-verify month asc/desc. **Commit.**
4. Toolbar sort control + client threading (feed/boundary/tree/flatTree) +
   persistence + full live-verify. **Commit.**

Each step builds, tests pass, and a slice works before the next.

## Resolved in review

1. **Default sort = `date_taken:desc`** — confirmed. Within-folder (and any
   non-date group) order changes from today's scan-order (`id`) to date-desc.
2. **Grouping follows the sort's date source** — confirmed. The year/month/day
   dimensions re-derive their column from the current date sort (§3); the date
   *filter/timeline* and *albums* still use `taken_at` (a future unification is
   noted in the timeline spec).
3. **Date fallbacks to `mtime`** — confirmed. `date_taken`/`date_created` fall
   back to `mtime` when EXIF/creation is missing (non-null, deterministic).
4. **"mbs" = megabytes** → covered by `size` (bytes; identical ordering);
   megapixels dropped. **Name sort case-insensitive** (`COLLATE NOCASE`).

## Deferred / follow-up issues (not built here)

- Aggregate group ordering: order groups by newest photo / count / max rating
  (per-group aggregation).
- Random / shuffle sort (seeded, pagination-stable).
- Camera / orientation sort attributes.
- Independent sort per nested group level.
