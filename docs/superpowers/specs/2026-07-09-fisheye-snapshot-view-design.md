# Fisheye snapshot view (3rd group state) + 20k auto-albums default — design

## Context

A grouped feed section (a day, a month, a folder) can hold thousands of photos. Today a
group is either **expanded** (every thumbnail rendered) or **collapsed** (a one-line
placeholder with just a count). There's no way to *glance* at a big group's contents
without expanding it and scrolling.

John wants a third state: a **fisheye snapshot** — a single, width-fitted row that stands
in for the whole group, showing the **first few photos + a fragment of the middle + the
last two**, so you get a scroll-free sense of an album/group. Only the sampled thumbnails
load, so it's cheap even for a 20k-photo group.

The same component solves a second problem. `AlbumsView` currently renders **every** photo
of **every** detected album as an `<img>` (`{#each album.ids as id}`), which is the sole
reason the auto-albums working set is hard-capped at 20,000. Dropping the snapshot strip
into each album row makes render cost independent of photo count — which is what lets us
**raise the auto-albums default to 20,000 and allow going bigger** (John's paired request).

Decisions locked in with John:

- Snapshot is a **3rd feed-group state** available on any grouped section (not AlbumsView-
  only). Header cycles **expanded → snapshot → collapsed → expanded**; expanded stays the
  default landing state (least-surprising; preserves current behavior).
- Sampling = **first few + middle fragment + last two**, width-fitted. Recipe: last 2
  fixed; ~60% of the remaining slots to the front; the rest sampled around the middle.
- The component is **shared**: it accepts either a group **path** (feed) or an explicit
  **id list** (AlbumsView).

## Architecture

### Sampling math (`server/db/sampleGroup.js` — new, pure + unit-tested)

```
sampleOffsets(count, slots) -> {
  offsets: number[],          // strictly increasing indices into [0, count)
  gaps: number[],             // indices in `offsets` after which a "…" gap belongs
}
```

Rules:

- `count <= slots` → `offsets = [0..count-1]`, `gaps = []` (whole group fits; no omission).
- else: `last = 2`; `first = ceil((slots - last) * 0.6)`; `mid = slots - last - first`.
  - front block: `0 .. first-1`
  - middle block: `mid` indices sampled evenly across the central region
    `[first + step .. count - last - step]` (never re-including a front/last index).
  - last block: `count-2, count-1`.
  - `gaps` marks the boundary after the front block and after the middle block (render an
    ellipsis where photos were skipped, only if a real gap exists there).

Edge cases the tests pin down: `slots` of 3–5 (front/middle/last still each get ≥1 where
possible), `count` just above `slots`, duplicate-offset avoidance.

### Sample endpoint (`GET /api/group/sample`)

Params: `path` (JSON `{dimension,value}[]` — the group at its depth), `filter`, `sort`,
`groupBy`, `slots`. Returns:

```
{ count: number, samples: Array<{ ...photo, offset: number, gapAfter: boolean }> }
```

Implementation reuses the feed's existing machinery so ordering matches exactly what
expanding the group would show:

- Group predicate = the same `{dimension,value}` → SQL condition builder the feed/tree use.
- `ORDER BY` = `applySortToDims(resolveDimensions(groupBy), sort)` dims, then the sort dim,
  then `photos.id` — identical to `getFeedPage`.
- `count` from the existing tree/count query for that path.
- Fetch the sampled rows with `sampleOffsets(count, slots)`: run the ordered group query
  with `LIMIT`/`OFFSET` for each contiguous run (front run, each middle pick, last run).
  Contiguous front and last are single `LIMIT/OFFSET` queries; middle picks are cheap
  single-row `LIMIT 1 OFFSET k` queries (≤ a handful). Attach `offset` and `gapAfter`.

> Reuse, don't re-derive: route through whatever shared dim/seek helper `getFeedPage`
> already uses (`server/db/feed.js`). Do **not** hand-roll a parallel ORDER BY — that's the
> exact duplication CLAUDE.md's debugging-discipline note warns about.

### Snapshot component (`ui/src/lib/SnapshotStrip.svelte` — new)

Props (one source, two shapes):

- `{ groupPath, count, filter, sort, groupBy }` — feed usage (fetches its own sample), **or**
- `{ ids }` — AlbumsView usage (already holds the ordered id list; samples client-side via
  the same `sampleOffsets` ported to `ui/src/lib/snapshot.js`, no fetch).

Behavior:

- Measures its own width with a **`ResizeObserver`** (event-driven; no `setTimeout`), maps
  width → `slots = floor((width + gap) / (thumb + gap))`.
- Refetches / re-slices **only when `slots` actually changes** (guard on the last-used slot
  count), so dragging a window edge doesn't spam the endpoint.
- Renders one flex row of small thumbnails (`thumbUrl(id, 160, mtime)`), with a subtle `…`
  marker at each `gapAfter`/`gaps` boundary. Fixed height, `overflow: hidden`, never wraps.
- Click a thumbnail → open the loupe at that photo (feed: dispatch the existing open-loupe
  event with the photo id; AlbumsView: same as its current per-thumb click if any).

### Feed integration (tri-state)

- State: a `Set` of group keys in **snapshot** state (`snapshotGroupKeys`), alongside the
  existing collapsed-group set. `pathKey(path)` (already in `feed.js`) is the key.
- Header interaction: clicking the collapse affordance cycles
  **expanded → snapshot → collapsed → expanded**. A small icon indicates the current state.
- Rendering: a new `displayEntries` entry `kind: "snapshot"` emitted for a group in
  snapshot state (mirrors how `kind: "placeholder"` is emitted for collapsed groups in
  `ui/src/lib/displayEntries.js`). The grid template renders it as one full-width
  `<SnapshotStrip groupPath=… count=… … />` row. `suppressPlaceholderHeaders`-style header
  handling extended so a snapshot row owns its boundary label (no duplicate sticky band).
- Reuse the collapsed-group plumbing rather than adding a parallel path; snapshot is a
  sibling of the placeholder case, not a new subsystem.

### AlbumsView adoption + 20k default

- Replace the per-album `{#each album.ids as id}<img>` (`ui/src/lib/AlbumsView.svelte`
  ~line 233) with `<SnapshotStrip ids={album.ids} />` — one strip per album.
- Server: raise/lift `ALBUM_TIMELINE_MAX` in `/api/albums/timeline`
  (`server/api.js` ~line 767). Rendering no longer scales with photo count; the DB query
  (`workingSetTimeline`) is fine into the hundreds of thousands. Keep a sane ceiling
  (e.g. 200000) purely as a DB-time safety, echoed back so the UI can show clamping.
- `AlbumsView` default `limit`: **2000 → 20000**. The `Max` input still lets the user go
  higher up to the (now much larger) server ceiling. Update the input's help text (drop
  the "isn't virtualized" caveat, since strips fix it).

## Testing

- **`sampleOffsets` unit tests** (`server/db/sampleGroup.test.js`, mirrored for the client
  port): whole-group-fits; large group produces front/middle/last with correct block
  sizes and `gaps`; small `slots` (3, 4, 5); no duplicate offsets; monotonic increasing.
- **Endpoint test** (`server/api.test.js`): `/api/group/sample` returns `count` +
  `samples` whose ids match the same-ordered `LIMIT/OFFSET` slice of the group's feed order
  (so snapshot order == expand order); respects `filter`/`sort`/`groupBy`.
- **Live verify** (per project convention, required for feed-window/App.svelte changes):
  via claude-in-chrome on the real library — cycle a large group expanded → snapshot →
  collapsed → expanded, confirm the strip shows first/middle/last with `…` gaps and fits
  the width with no wrap; resize the window and confirm the strip re-slices without
  spamming requests (network tab); click a strip thumb and confirm the loupe opens on that
  photo; in AlbumsView, load 20k and confirm the album list renders promptly (strips, not
  20k `<img>`).

## Out of scope (this spec)

- The background-job system, panel, and materialize-move — separate spec
  (`2026-07-09-background-jobs-panel-design.md`).
- Virtualizing the *expanded* album grid (snapshot sidesteps the need for now).
- Persisting per-group snapshot/collapsed state across reloads (nice-to-have; the existing
  collapse state's persistence approach, if any, extends naturally later).
