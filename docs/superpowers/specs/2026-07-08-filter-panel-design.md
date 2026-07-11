# Filter panel + EXIF grouping (Slice 1) — design

_Date: 2026-07-08. Read with `CLAUDE.md` and
`docs/superpowers/specs/2026-07-06-photo-triage-design.md`._

## Goal

Let the user narrow the grid while culling, and group by more of what the
camera recorded:

- **Filter by star rating** — a threshold: "≥ N stars".
- **Filter by orientation** — multi-select toggles Landscape / Portrait /
  Square (derived from stored width/height, no new EXIF work).
- **Group by camera and kind** — new grouping dimensions alongside
  folder/year/month/day.

## Scope decomposition

The original ask ("filtering + EXIF characteristics + grouping by camera etc.")
is 2–3 separable pieces. This spec is **Slice 1** only:

| Piece                                                 | This spec? | Why                                                                                       |
| ----------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| A. Filter panel (rating ≥ N, orientation toggles)     | ✅         | Query-layer WHERE + UI, no schema change                                                  |
| B. Free grouping dims (camera, kind)                  | ✅         | Columns already exist; one registry entry each                                            |
| C. Rich EXIF dims (lens, ISO, focal length, aperture) | ❌ later   | Needs schema migration + extract-during-scan + backfill of 10k photos + numeric bucketing |

C gets its own spec after this, and benefits from the filter compiler built
here (you'll want to filter by lens too).

## Non-negotiable constraint

Filtering **cannot** be client-side. The feed is keyset-paginated
(`server/db/feed.js`): filtering a 60-item window client-side yields a near-empty
grid with broken infinite scroll. The filter must be a SQL WHERE clause so the
DB walks past excluded rows during the seek, and so counts/boundaries agree with
what is shown.

## Architecture

### 1. Filter compiler — `server/db/filters.js` (new, pure)

```js
buildFilter(spec) → { sql: string, params: any[] }   // "1=1" when empty
```

The **filter spec** (client → server, JSON):

```js
{
  minRating: 0,                                    // 0 = off; N ⇒ rating >= N
  orientations: ["landscape", "portrait", "square"] // all three (or absent) = off
}
```

Compilation rules:

- **Rating** → `photos.rating >= ?` as a bound param. `minRating: 0` compiles
  to nothing (no-op).
- **Orientation** → an OR of **hardcoded** SQL fragments keyed by name, guarded
  by non-null dimensions:
  - `landscape` → `photos.width > photos.height`
  - `portrait` → `photos.height > photos.width`
  - `square` → `photos.width = photos.height`
  - Wrapped: `photos.width IS NOT NULL AND photos.height IS NOT NULL AND (…OR…)`.
  - Selecting **all three (or none)** = no constraint at all (not even the
    non-null guard) — "all on" ≡ "orientation filter off".
- **Empty spec** → `{ sql: "1=1", params: [] }` so callers can unconditionally
  `AND (${filter.sql})`.

**Security**: orientation names index a fixed fragment table — user strings are
never interpolated into SQL. Rating is a bound param. `api.js` additionally
validates the shape (minRating an int 0–5; orientations a subset of the three
allowed names) and returns 400 on anything else. Zero injection surface.

### 2. Threading (every set-reasoning query ANDs the filter)

A filter that touches the grid but not the counts/jumps produces lying counts
and jumps into empty sections. So the compiled filter ANDs into **all** of:

- `getFeedPage` — both `fetchRealRows` **and** `countCollapsedPath`
  (placeholder counts).
- `findGroupBoundary` — all its seek queries (group-jump must skip
  filtered-out groups).
- `getTreeNode` / flat-tree counts (`server/db/tree.js`).

Each takes an optional `filter` (default the empty `{sql:"1=1",params:[]}`) and
splices `AND (${filter.sql})` into its existing WHERE, with `filter.params`
spliced into the bound params in the right position. This is the single shared
predicate the CLAUDE.md "don't hand-roll a seventh copy" rule calls for.

**Empty groups vanish for free**: a group with zero matching photos returns no
rows → no header derived → tree count 0. Zero-count tree nodes are hidden so the
navigator only shows reachable groups. _(Decision: hide, not gray out.)_

### 3. New grouping dimensions — `DIMENSIONS` in `feed.js`

```js
camera: { expr: "COALESCE(photos.camera, '')", direction: "ASC" }, // '' ⇒ "Unknown"
kind:   { expr: "photos.kind", direction: "ASC" },                 // NOT NULL
```

The grouping machinery (tree, boundary, headers, `formatGroupValue`) already
iterates the registry generically — no per-dimension code. `camera` and `kind`
are added to `ALL_DIMENSIONS` in App.svelte so the existing `MultiAutoSelect`
grouping picker offers them automatically.

### 4. UI

- **`ui/src/lib/FilterPanel.svelte`** (new component — App.svelte is already
  ~2065 lines; a focused component is the right call). A **"Filter ▾"** button
  in the topbar (mirrors the Library dropdown) opens a popover:
  - **Rating**: segmented control `Any · ≥1 · ≥2 · ≥3 · ≥4 · 5`.
  - **Orientation**: three toggle chips — Landscape / Portrait / Square.
  - **Clear** button.
- **Active indicator**: the Filter button shows a badge/dot whenever a filter is
  hiding photos, so a sparse grid is never a mystery.
- **`ui/src/lib/filterSpec.js`** (new, pure): `isActive(spec)`,
  `toQueryParam(spec)`, `DEFAULT_FILTER` — DOM-free and unit-tested.

### 5. Behavior on filter change

Reuses the reset path that a `groupBy` change already uses: bump `feedEpoch`,
reset the window, reload. **Keep the currently-selected photo as focus if it
still passes the filter; otherwise reload from the top** of the current
hierarchy. The active filter **persists in localStorage** like `groupBy`/`zoom`.

### 6. Wire-up: `filter` query param

`ui/src/lib/api.js` adds an optional `filter` param (JSON) to `fetchFeed`,
`fetchGroupBoundary`, `fetchTreeNode`, `fetchFlatTree`; only sent when active.
`server/api.js` parses + validates it on `/api/feed`, `/api/feed/boundary`,
`/api/tree`, `/api/flatTree`.

## Verify during implementation (do NOT assume)

1. **Orientation correctness depends on `width`/`height` being
   display-normalized.** A portrait photo stored as landscape-dims plus an EXIF
   rotation tag would classify wrong. The roadmap claims metaCache normalizes
   EXIF orientation — confirm against real Canon/Pixel photos before trusting
   `width > height`.
2. **Zero-count node hiding** — verify in the real sidebar tree, not only a unit
   test.

## Testing

- **`filters.test.js`** — table-driven spec → `{sql, params}`, including all-off
  no-ops and the non-null guard.
- **feed / tree tests** — `getFeedPage`, `findGroupBoundary`, tree counts _with_
  a filter, on the existing test-DB harness; assert filtered-out groups produce
  no rows and zero counts.
- **`filterSpec.test.js`** — `isActive` / `toQueryParam` / default.
- **Live browser verification** (required by CLAUDE.md, this touches feed-window
  ordering/state): on a real folder, filter to ≥4 + portrait, scroll, group-jump
  (Option+←/→), and confirm section counts match visible photos and the tree
  hides empty groups.

## Files

**New**: `server/db/filters.js` (+`filters.test.js`),
`ui/src/lib/FilterPanel.svelte`, `ui/src/lib/filterSpec.js`
(+`filterSpec.test.js`).

**Edit**: `server/db/feed.js` (dims + threading),
`server/db/tree.js` (threading + hide-zero), `server/api.js`
(parse/validate on 4 endpoints), `ui/src/lib/api.js` (filter param),
`ui/src/App.svelte` (state + wiring + `ALL_DIMENSIONS`).

## Out of scope (Slice 1)

- Lens / ISO / focal length / aperture grouping (Slice C).
- Filtering by camera/kind (the compiler is generic enough to add later; the UI
  ships rating + orientation only, per YAGNI).
- Filtering by date range (grouping already covers date navigation).
