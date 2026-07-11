# Tree sidebar & in-place collapse folding — Design

Status: Approved, ready for implementation plan
Date: 2026-07-06

## Context & problem

The grouped endless feed (`docs/superpowers/specs/2026-07-06-grouped-endless-feed-design.md`,
merged to `main`) lets a photo be grouped by an ordered hierarchy of
dimensions (folder/year/month/day) and lets any section collapse to stop
fetching its contents. Two gaps surfaced from live use of that feature:

1. There's no map of the hierarchy — you can't see the shape of your
   library (how many folders, how many photos per year) or jump straight
   to a section without scrolling past everything before it.
2. Collapsing a section currently renders as a small re-expandable "chip"
   in the topbar (a scoped compromise from the feed branch's final
   review), not as an in-place folded header the way VS Code folds a
   function body — the section vanishes from where it was and reappears
   as a disconnected pill elsewhere.

Both gaps point at the same fix: a persistent tree view of the hierarchy
that becomes the primary way you fold/unfold sections, with the feed
folding sections in place to match.

## Goal

1. A persistent, always-visible left sidebar showing the current grouping
   hierarchy as a tree — root shows the whole library's total photo/video
   count, each node shows its own count, lazily expanding one level at a
   time as you drill in.
2. The tree becomes the primary fold/unfold control. A plain click on a
   node's fold icon collapses it in the feed (hiding its photos, exactly
   like today) without touching any descendant tree node's own expand
   state. A shift-click does the same feed-collapse, and additionally
   resets every descendant tree node's expand memory back to collapsed —
   so re-expanding the parent later starts fresh rather than popping back
   open wherever you'd previously drilled into. The feed's own existing
   per-header fold icon keeps working too, as a secondary affordance —
   both mutate the same shared `collapsedPaths` state.
3. A manual "reveal current location" action (a topbar button) that walks
   the tree down to wherever you're currently positioned in the feed,
   lazily expanding each level as needed, and highlights the result. Not
   continuous auto-tracking — the tree doesn't fight your own navigation
   while you're mid-scroll or looking around a different part of it.
4. Collapsing a section folds it **in place** in the feed — the header
   stays exactly where it was in scroll position, shown folded (▸ + count),
   with no photos underneath — replacing the topbar-chip mechanism
   entirely.

## Two distinct kinds of state

Easy to conflate, so stated explicitly:

- **`collapsedPaths`** (already exists in `App.svelte`, shared between the
  tree and the feed): which paths are hidden from the feed. A path is a
  prefix of the current `groupBy` order, and collapsing it already hides
  everything nested underneath — the server's exclusion is a prefix match,
  so a folder-level collapse already excludes its years and months too.
  This needs no new cascading logic; it works today.
- **The tree's own expand state** (new, tree-only, never sent to the
  server as part of `collapsedPaths`, never affects the feed): whether the
  tree UI is currently showing a node's children as a fetched, rendered
  nested list. A folder can be collapsed in the feed while still expanded
  in the tree (you're looking around inside it without un-hiding its
  photos) — these are independent per-node booleans owned entirely by
  `TreeSidebar.svelte`.

"Fold all descendants" (shift-click) is a **pure tree-UI operation** on the
second kind of state — it does not change what the feed excludes beyond
what a plain click already does (the exclusion already cascades). It only
resets descendant tree nodes' own expand memory.

## Server: hierarchy-count endpoint (new)

`GET /api/tree?groupBy=folder,year&path=<json>`

- `groupBy`: same comma-separated dimension list as `/api/feed`, validated
  against the same `DIMENSIONS` whitelist in `server/db/feed.js`.
- `path`: JSON array of `{dimension, value}` pairs — the ordered prefix
  identifying whose children to fetch. Omitted or `[]` means the root
  (top-level nodes of `groupBy[0]`).
- Response: `{ total, nodes: [{value, label, count, hasChildren}] }`.
  `nodes` is one row per distinct value of the dimension at depth
  `path.length` within `groupBy`, each with its own `COUNT(*)` scoped to
  that prefix — implemented as a single `GROUP BY <dimExpr>` query with a
  `WHERE` built the same way `collapsedPathCondition` already builds a
  prefix-equality condition in `feed.js`, just without the `NOT`. `label`
  reuses the client's existing `formatGroupValue` convention (the
  raw `value` plus how "Unknown" is derived from the empty-string
  sentinel) — or a server-side equivalent, whichever avoids duplicating
  that mapping; the implementation plan decides which side owns it.
  `hasChildren` is `path.length + 1 < groupBy.length`. `total` is only
  meaningful for the root call (`path` empty) and is a plain
  `COUNT(*) FROM photos WHERE stale=0` — the number the sidebar's root
  "main note" displays.
- One query per expand click — bounded regardless of library size, no
  full-tree walk, matching the feed's own "collapsing costs nothing"
  guarantee and this endpoint's lazy-loading design.
- No new schema, no new dimension logic — reuses `DIMENSIONS` and
  `resolveDimensions` from `server/db/feed.js` verbatim.

## Server: in-place collapsed placeholder

Extends `getFeedPage` (`server/db/feed.js`): the real (non-collapsed) rows
for a page are computed exactly as today — unchanged query, unchanged
cost. Additionally, for each path in `collapsed`, compute where that
path's fixed prefix values would sort _within this specific page_, using
the same per-dimension comparator convention already used for keyset
seeking (`cmpOp`/`seekCondition`). If that position falls within the
page's actual boundary (between two adjacent real rows already returned,
or at the true start/end of the whole feed), splice in one lightweight
`{ collapsed: true, path, count }` entry at that index — no real rows for
the collapsed range are ever fetched, preserving the existing "collapsing
costs nothing beyond the header row" guarantee validated in the feed
branch. A collapsed path whose range doesn't overlap the currently
requested window costs nothing and produces no entry, same as today's
`getCollapsedSummaries` behavior.

The exact boundary-detection expression (particularly: is a collapsed
range at the very edge of the whole feed, vs. simply outside this page but
inside a later one) is a query-builder implementation detail the plan
owns, not something pinned down further here — same treatment the original
feed design gave the seek expression itself.

`getFeedPage`'s existing `sections` field (currently used by the
topbar-chip mechanism) becomes redundant once placeholders are spliced
directly into `items` and is removed along with the chip UI.

## Client: `TreeSidebar.svelte` (new component)

A new component — not grown inline into `App.svelte` (already 1248
lines) — that owns the tree's own lazy-expand state (a per-node
expanded/collapsed boolean, keyed by path, independent of
`collapsedPaths`) and renders whatever `/api/tree` returns. Props from
`App.svelte`: `groupBy` (read) and `collapsedPaths` (read); emits a toggle
event consumed by `App.svelte`'s existing `toggleSectionCollapse`, so the
tree's fold icon and the feed's own per-header fold icon both mutate the
same shared state, from two call sites.

Each rendered node shows: its label, its count, a fold icon (plain click =
collapse in feed; shift-click = collapse in feed + reset descendant
tree-expand memory), and is clickable to jump to that section in the feed
(reusing the existing `scrollToSection` approach, extended to work from a
tree node that may not currently be loaded in the feed's window at all —
jumping there triggers a `focusId`-less positional fetch centered on that
path's start, the same shape of request `onGroupByChange` already makes
today).

The "reveal current location" action lives in the topbar (near the
existing grouping-hierarchy selector). On click: read the currently
selected/focused photo's `groupValues` (already available via
`resolvePhoto`), walk `groupBy` from the outermost dimension inward,
triggering a lazy `/api/tree` fetch at each level if that level isn't
already loaded in the tree, then scroll the tree to and highlight the
resulting leaf node.

## Client: `App.svelte` integration

The sidebar is always-visible, added as a persistent flex column beside
the existing grid — `gridWidth`'s existing `bind:clientWidth`-driven
layout math already recomputes the justified layout and section-header
positioning from whatever width it's given, so no new layout logic is
needed there, only a narrower container. The topbar-chip mechanism (the
`collapsedSummaries` state and its pill rendering, added during the feed
branch's final-review fix) is removed entirely — the tree now shows every
collapsed section with its own re-expand affordance directly, and the
feed folds in place.

## Testing

- Server: `server/db/tree.js` (or a new export from `feed.js` — the plan
  decides file boundaries) with tests following `feed.test.js`'s existing
  pattern — a real DB fixture, assertions on grouped counts at several
  path depths, the root `total`, and `hasChildren` at the deepest
  dimension. Extend `feed.test.js` for placeholder-splicing: a collapsed
  range fully inside a page, at the page's start, at its end, multiple
  collapsed paths within one page, and a collapsed path outside the
  requested window producing no placeholder.
- Client: any nontrivial pure logic that emerges while implementing the
  two-tier fold operation or the reveal-path walk gets its own
  pure-function test file, matching `ui/src/lib/feed.js`'s existing
  pattern (no DOM, no Svelte). `TreeSidebar.svelte` itself gets manual
  browser verification only, matching this project's established
  no-automated-tests-for-Svelte-components convention (per
  `docs/ROADMAP.md`'s working agreement).

## Out of scope

- Continuous auto-tracking of scroll position in the tree (deliberately
  manual-only — see Goal #3).
- Album (#3) and tag-based (people/features) tree dimensions — same
  unpopulated-tables reason the feed design already deferred these.
- Persisting the tree's expand state or `collapsedPaths` across reloads —
  matches the feed's existing decision not to persist collapse state,
  extended to the tree's own local expand memory for the same reason (a
  silently-collapsed/expanded tree on reopen, with no visual cause, is a
  footgun for no clearly-asked-for benefit).
- Any change to burst-stack detection, rating, cover-choice, loupe logic,
  or the composite ordering/keyset-pagination core — this spec only adds a
  navigation surface and reworks how collapse renders, not what's fetched
  or how photos within a section are ordered.

## Validation

After implementation, exercise against the real indexed archive
(`docs/TEST_FOLDERS.local.md`): confirm the root node's total matches the
library's actual indexed photo count, expanding a node fetches only that
level's children (not a full-tree walk — verify via network request log),
collapsing a large section from the tree folds it in place in the feed
with no chip appearing in the topbar, a plain-click collapse followed by
re-expand preserves whatever the tree had drilled into beneath it, a
shift-click collapse followed by re-expand shows a freshly-folded subtree,
and the reveal-current-location button correctly walks to and highlights
the section containing whatever's currently focused in the feed. Read-only
against the real archive per the working agreement.
