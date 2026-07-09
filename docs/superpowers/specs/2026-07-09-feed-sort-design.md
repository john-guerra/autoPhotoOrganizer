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
- **Attributes (v1):** date, rating, file size, filename, **megapixels** (`w×h`).
  Each with an asc/desc direction. (Camera/orientation and a random "shuffle" are
  deferred.)
- **Group sorting (v1):** only the **trivial case** — when the sort attribute is
  *also* a group dimension (sort by date while grouped by year/month/day), the
  date group dimensions follow the sort direction. Ordering groups by an aggregate
  of a *non-grouped* attribute (folders by newest photo / by count) is deferred.

## Goals

1. A `sort: { by, dir }` spec threaded into `getFeedPage`'s seek tuple → orders
   photos within leaf groups, and orders the whole feed when `groupBy` is empty.
2. Sortable attributes: **date, rating, size, name, megapixels**, each asc/desc.
3. A toolbar **sort control** (attribute + direction), persisted.
4. **Date-sort ↔ date-dimension coupling:** when sorting by date, the year/month/
   day group dimensions (in the feed *and* the tree/fisheye sidebars) follow the
   sort direction, so groups and photos agree — this is how month asc/desc becomes
   a toggle.

## Non-goals (this slice)

- Aggregate group ordering (order folders by newest photo, by count, by max
  rating) — deferred; needs per-group aggregation in the grouping query + seek.
- Random / shuffle sort — deferred; true random breaks keyset pagination unless
  seeded, which is separate work.
- Camera / orientation sort attributes — not in the v1 set.
- Independent sort per nested group level.

---

## Architecture

### 1. Sortable-attribute registry

A small map beside `DIMENSIONS` (`server/db/feed.js`, or a new
`server/db/sortAttrs.js`), each entry a **null-safe, deterministic** SQL expr —
determinism only needs to be *total together with the `id` tiebreak*, so ties are
fine:

```js
export const SORT_ATTRS = {
  date:       { expr: "COALESCE(photos.taken_at, photos.mtime)" },
  rating:     { expr: "photos.rating" },                 // 0..5, NOT NULL default 0
  size:       { expr: "photos.size" },                   // bytes, NOT NULL
  name:       { expr: "photos.filename COLLATE NOCASE" },// case-insensitive
  megapixels: { expr: "(COALESCE(photos.width,0) * COALESCE(photos.height,0))" },
};
```

`by` defaults to **`date`**, `dir` defaults to **`desc`** (see Open Questions —
this changes within-*folder* order from scan-order to date-desc).

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

The one place sort touches *group* order. A helper:

```js
// date sort is the only v1 attribute that corresponds to group dimensions.
const SORT_DIM_FAMILY = { date: ["year", "month", "day"] };

/** Return dims with directions overridden to follow the sort, where they correspond. */
export function applySortToDims(dims, sort) {
  const family = SORT_DIM_FAMILY[sort?.by];
  if (!family) return dims;
  return dims.map((d) =>
    family.includes(d.name) ? { ...d, direction: sort.dir.toUpperCase() } : d
  );
}
```

Applied **wherever group order is resolved**, so groups and photos agree
everywhere:

- `getFeedPage` and `findGroupBoundary` (feed.js) — feed + next/prev-group nav.
- `getTreeNode` and `getFlatTree` (`server/db/tree.js`) — the tree sidebar and the
  fisheye navigator, so the sidebar's month order matches the feed.

So: group by `month`, sort `date` ascending → the sidebar and the feed both read
January → December. rating/size/name/megapixels have no dimension family, so they
only sort *within* leaf groups (and the flat feed) — groups keep their default
order.

### 4. Server: parse & validate

`server/api.js` reads a `sort` query param on the feed, boundary, tree, and
flat-tree endpoints — `by:dir` (e.g. `rating:asc`) or a small JSON object. Coerce:
`by` must be a `SORT_ATTRS` key (else `date`), `dir` ∈ {asc,desc} (else `desc`).
Invalid → default, **not a 400** — sort is a display nicety, and defaulting keeps
the feed rendering. (The count/ids endpoints are order-independent and take no
`sort`.)

### 5. Client

- **State:** `sort = { by, dir }` in `App.svelte`, persisted in localStorage
  (`autogallery.sort`), defaulting to `{ by: "date", dir: "desc" }`.
- **Threading:** pass `sort` through `fetchFeed`, `fetchGroupBoundary`,
  `fetchTreeNode`, `fetchFlatTree` (`ui/src/lib/api.js` serializes it to the query
  string). It joins the existing `displayFilter`/`groupBy` recompute path, so any
  change re-pulls the feed + sidebars.
- **Control:** a compact `sort by ▾ [date|rating|size|name|megapixels]  ⇅` in the
  toolbar's organize cluster (near group-by). The `⇅` toggles asc/desc. Same
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
  exprs (undated → `mtime`; missing rating → 0; missing dimensions → 0 MP); the
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
- `applySortToDims` (`feed.test.js`): date sort overrides year/month/day
  direction; non-date sort is a no-op; unknown `by` is a no-op.
- Coupling reaches the tree: `getFlatTree`/`getTreeNode` month order flips with
  date `dir` (`tree.test.js`).
- Param parse (`api.test.js`): `sort=rating:asc` honored; garbage → date:desc.

**Live (App.svelte manual-verify convention):**
- Flat feed (remove all group levels) → sort by rating desc, size desc, name asc,
  megapixels desc each reorder the grid correctly; direction toggle reverses.
- Group by folder, sort by rating → photos reorder *within* each folder; folder
  order unchanged.
- Group by month, sort date asc vs desc → **both the month headers and the
  sidebar** flip Jan↔Dec; the feed photos within follow.
- Sort persists across reload; seek/focus (arrow nav, group jump) stays correct.

---

## Build order (checkpoints)

1. `SORT_ATTRS` registry + `getFeedPage` seek-tuple sort dim + `sort` param parse
   + unit tests (within-group, flat, pagination-stable). Verify via `curl`.
   **Commit.**
2. `applySortToDims` coupling across feed / boundary / tree / flat-tree + tests +
   live-verify month asc/desc. **Commit.**
3. Toolbar sort control + client threading (feed/boundary/tree/flatTree) +
   persistence + full live-verify. **Commit.**

Each step builds, tests pass, and a slice works before the next.

## Open questions (confirm during spec review)

1. **Default sort = `date:desc`.** This changes within-*folder* (and any
   non-date group) order from today's scan-order (`id`) to date-descending.
   Intended, or keep `id` as the default and only sort when the user picks one?
2. **"mbs" = megapixels** (`width × height`) — confirm you didn't mean megabytes
   (file size, already covered by `size`).
3. **Name sort case-insensitive** (`COLLATE NOCASE`) — assumed; ok?

## Deferred / follow-up issues (not built here)

- Aggregate group ordering: order groups by newest photo / count / max rating
  (per-group aggregation).
- Random / shuffle sort (seeded, pagination-stable).
- Camera / orientation sort attributes.
- Independent sort per nested group level.
