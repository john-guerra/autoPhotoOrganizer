# Grouped endless feed — Design

Status: Approved, ready for implementation plan
Date: 2026-07-06

## Context & problem

The persistent multi-drive index (`docs/superpowers/specs/2026-07-06-persistent-multi-drive-index-design.md`,
merged to `main`) gives every photo a stable id and a queryable home in
SQLite, but the UI (`ui/src/App.svelte`) still works exactly like before:
one `POST /api/scan` returns every item in a single folder, the whole array
lives in browser memory, and `ui/src/lib/layouts/windowing.js` only
virtualizes which `Thumb` DOM nodes are mounted — the underlying data is
never partial.

That doesn't scale to "browse my whole library" (John's real archive: a
~111K-photo folder tree today, real backup drives eventually in the
millions). Loading every photo's metadata into the browser upfront isn't
viable, so the feed needs windowed **data** fetching, not just windowed
**rendering** — the server must page through the index, not hand over
everything at once.

This is the direct follow-up scoped out of the persistent-index spec's
"Out of scope" section: "The grouped endless-feed UI itself
(keyset-paginated queries, grouping selector, infinite scroll) ... this
spec is the data layer it will be built on top of."

## Goal

Replace the single-folder grid with a continuous, cross-folder feed that:

1. Shows every photo already indexed (the whole library so far), by
   default grouped by folder — reproducing today's single-folder view as
   one degenerate case (one group).
2. Lets the user build an **ordered, multi-level grouping hierarchy**
   (e.g. Year → Folder, or Folder → Day) via a drag-orderable multi-select,
   not just a single flat "group by X" dropdown.
3. Renders cascading, **collapsible** sticky section headers per level —
   collapsing a section (say, an entire Year) stops the app from fetching
   anything inside it, replacing it with one lightweight count summary.
4. Scrolls infinitely in both directions via keyset pagination centered on
   a focus point (the pattern ported into the persistent-index spec from
   PhotoRing, now generalized to a composite multi-level sort key instead
   of one dimension).
5. Preserves every existing interaction — star ratings, manual cover
   choice, burst-stack collapse/expand, keyboard grid nav, the loupe, zoom
   — unchanged from the user's point of view.

## Grouping dimensions (v1)

Four dimensions, each a plain SQL expression over `photos`/`folders` — no
new schema, no precomputation:

| Dimension | Expression                                                                     | Default direction |
| --------- | ------------------------------------------------------------------------------ | ----------------- |
| `folder`  | `folders.abs_path`                                                             | ascending         |
| `year`    | `COALESCE(strftime('%Y', photos.taken_at/1000, 'unixepoch'), 'Unknown')`       | descending        |
| `month`   | `COALESCE(strftime('%Y-%m', photos.taken_at/1000, 'unixepoch'), 'Unknown')`    | descending        |
| `day`     | `COALESCE(strftime('%Y-%m-%d', photos.taken_at/1000, 'unixepoch'), 'Unknown')` | descending        |

`taken_at` is nullable (stored as epoch ms); photos with no capture date
collapse into an `'Unknown'` bucket sorted last, rather than being dropped.
Album (#3) and tag-based (people/features) grouping are **not** in this
spec — the schema's `photo_album`/`photo_tags` tables are still
unpopulated (per the persistent-index spec) — but the grouping mechanism
here is designed to add them later as more dimensions in the same ordered
list, once something populates those tables.

## Hierarchy selection UI

An ordered multi-select — validated live in the browser companion using
John's own [`multi-auto-select`](https://www.npmjs.com/package/multi-auto-select)
package (drag-orderable pills, typeahead add/remove) — lets the user pick
a subset of the four dimensions above and order them outermost-first (e.g.
`["year", "folder"]`). New dependencies: `multi-auto-select` + its peer
`sortablejs`. The chosen order is persisted to `localStorage`
(`autogallery.groupBy`), same pattern as today's `zoom`/`burstGapMs`.

Each level renders as its own sticky header, indented and sized by depth
(outermost = largest/boldest, sticky at `top: 0`; each inner level sticky
just below its parent's header — stacking naturally as you scroll past
nested boundaries). Every header has a ▾/▸ toggle. Collapsed-state is
**not** persisted across reloads (a fresh load starts fully expanded) —
persisting it added a real footgun (silently-collapsed content on next
open, with no visual cue why the feed looks sparse) for no clearly-asked-for
benefit.

## API: `GET /api/feed`

```
GET /api/feed?groupBy=year,folder&collapsed=<json>&focusId=<id>&before=N&after=M
→ { items: FeedItem[], sections: SectionSummary[] }
```

- `groupBy`: comma-separated dimension list, outermost first.
- `collapsed`: JSON array of collapsed paths, each an ordered list of
  `{dimension, value}` pairs matching a prefix of `groupBy` (e.g.
  `[{dimension:"year",value:"2015"}]` collapses all of 2015, regardless of
  folder).
- `focusId` + `before`/`after`: keyset pagination centered on a photo id's
  position in the current composite order — omit `focusId` for the initial
  load (equivalent to "start of the order," i.e. the very first section).

**Composite ordering**: `ORDER BY <dim0 expr> <dir0>, <dim1 expr> <dir1>,
..., photos.id`. Seeking past a `focusId` with mixed per-dimension
directions isn't a single tuple comparison — it's the standard multi-column
keyset "seek" expansion (`a < x OR (a = x AND (b > y OR (b = y AND ...)))`,
operators flipped per dimension's direction). This is a query-builder
implementation detail, not something this design pins down further; the
implementation plan owns the exact expression.

**Collapse-aware exclusion**: rows whose composite prefix matches any
`collapsed` path are excluded from the normal photo query
(`NOT (dim0_expr = ? [AND dim1_expr = ? ...])` per collapsed path, ANDed
together). For each collapsed path whose range falls inside the requested
window, a separate `GROUP BY`-count query produces one summary row
(`{collapsed: true, path, count}`) inserted at the correct sort position —
so the header still renders with a real count, with nothing underneath
fetched. Only collapsed paths overlapping the _current_ window are
summarized; a collapsed path far outside the loaded range costs nothing
until scrolled near.

**Changing the hierarchy** discards the loaded window, clears the
collapsed-path set (a collapsed path is a prefix in the _old_ `groupBy`
order and generally isn't even a valid prefix of the new one), and
re-fetches centered on the currently-focused photo's position in the new
order — "currently-focused" meaning whichever photo is presently
keyboard-selected (`selected` in `App.svelte` today), falling back to the
start of the feed if nothing is selected yet. This preserves "where you
were," the same context-preservation idea PhotoRing's README described for
jumping between dimensions.

## Frontend integration

- New `ui/src/lib/feed.js` (pure functions, no DOM — same shape as
  `displayEntries.js`/`bursts.js`): tracks the loaded window (an ordered
  array of `FeedItem`/`SectionSummary` entries), merges newly-fetched
  before/after pages into it, and derives section-boundary/header
  metadata for rendering — mirroring how `detectBursts`/`buildDisplayEntries`
  already derive burst-stack structure from a flat item array today.
- `App.svelte` swaps its single big `doScan()` → `items = res.items` model
  for: initial `/api/feed` fetch on mount, then `/api/feed` calls
  triggered by scroll proximity to either end of the loaded window
  (extending `updateVisibleRange`'s existing scroll-driven recompute, not
  replacing it — DOM virtualization still applies on top of whatever's
  loaded).
- Burst-stack detection, ratings, manual cover choice, the loupe, and
  keyboard grid navigation all continue operating on whatever's currently
  loaded, unchanged in behavior — they don't currently assume "the whole
  folder," just "an ordered array," which the feed's loaded window still
  is.
- `POST /api/scan` (add a new folder to the index) stops being the primary
  action; it becomes a secondary "add a folder" affordance (topbar
  popover), since the feed already shows everything indexed. The
  scanned-folders `Library` dropdown keeps its existing purpose (jump to a
  folder-scoped view is still possible by setting `groupBy=folder` and
  filtering, though a folder-scoped shortcut is left as a UI nicety, not a
  hard requirement here).

## Testing

vitest, following the established pattern:

- `server/db/feed.test.js`: composite ordering (multiple dimensions, mixed
  directions), keyset pagination correctness (before/after a focus id),
  collapse-exclusion (a collapsed path's photos never appear in `items`),
  summary-row counts (collapsed path within the window produces one
  correctly-counted row), `Unknown` bucket for null `taken_at`.
- `ui/src/lib/feed.test.js`: pure-function tests for window merging
  (appending an "after" page, prepending a "before" page, hierarchy-change
  reset), section-boundary derivation — no component tests, matching
  `displayEntries.test.js`/`bursts.test.js`.

## Out of scope

- Album (#3) and tag-based (people/features) grouping dimensions — the
  mechanism supports adding them once those tables are populated, but
  populating them is separate work.
- A folder-scoped "quick view" shortcut UI (mentioned above as a nicety).
- Persisting collapsed-section state across reloads (deliberately not
  done — see "Hierarchy selection UI").
- Any change to burst-stack detection, rating, cover-choice, or loupe
  logic beyond continuing to operate on the feed's loaded window instead
  of a whole-folder array.

## Validation

After implementation, exercise the feed against the real indexed data from
the persistent-index work (134,760 rows already in `~/.autogallery/index.db`
per that spec's validation) — confirm scrolling both directions works,
collapsing a large section (e.g. a whole year) stops new thumbnail
requests for its contents, and switching grouping hierarchies re-centers
on the previously-focused photo. Read-only against the real archive per
`docs/TEST_FOLDERS.local.md`'s working agreement.
