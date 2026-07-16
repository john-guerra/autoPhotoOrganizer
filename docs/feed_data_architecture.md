# Feed data & layout architecture

_How a photo gets from disk to a positioned tile on screen, and where the current
"fast fling stops at the end" / "scrollbar doesn't reflect the library" problems
come from. Snapshot as of 2.16.6._

This is a **description of what exists today**, written as the shared substrate
for the ongoing design discussion about full-library virtual scrolling. It is not
a proposal — proposals live in `docs/superpowers/specs/`.

---

## 1. The one-paragraph summary

The grid is a **sliding window over a sorted/grouped/filtered list**. The client
never holds the whole library; it fetches a contiguous run of items around a focus
point (`/api/feed?before&after&focusId`) and appends more as you scroll. Each
item carries its pixel `width`/`height` when known; the client turns those into
aspect ratios and runs a **pure justified-layout pass** to assign every loaded
item an absolute `{x, y, width, height}` box. The scroll container is sized to the
**loaded** content only. Dimensions are populated **lazily** — most rows are
`NULL` until browsed — so the layout initially **guesses** aspect ratios and
reflows when the truth arrives.

Two consequences drive the current pain:

- **The scroll height is a false floor.** It reflects loaded items, not the
  library, so a fast fling clamps at the bottom of what's loaded and the scrollbar
  can't convey true size or position. (2.16.6 adds a bounded bottom _reserve_ as a
  stopgap; it does not make the scroll height true.)
- **The layout guesses then corrects.** `DEFAULT_RATIO = 1.5` until real
  dimensions stream in, causing reflow (absorbed today by scroll-anchoring).

---

## 2. The data path, end to end

```
 disk (source of truth)
   │  scan (path+mtime+size identity)
   ▼
 SQLite `photos`  ── width/height/taken_at initially NULL (lazy) ──┐
   │                                                               │
   │  GET /api/feed?groupBy&filter&sort&focusId&before&after       │ GET /api/meta?ids=…
   ▼                                                               ▼  (on-demand dimension read)
 feed page: rows → rowToItem → items[]      ◄───────── enrichMeta() patches width/height/takenAt
   │        {id,name,size,mtimeMs,rating,width|null,height|null,taken_at,kind,duration,…}
   ▼
 displayEntries[]  (photos + placeholder bands for collapsed groups + stacks)
   │  map each entry → { id, aspectRatio }   aspectRatio = width/height  OR  DEFAULT_RATIO(1.5)
   ▼
 sectionedJustifiedLayout(entries, headers, {containerWidth, targetRowHeight, gap, headerHeight})
   │        pure O(n) math — NO DOM measurement except containerWidth
   ▼
 layoutResult { boxes:[{id,x,y,width,height}], headers:[{y,endY,…}], totalHeight }
   │
   ├─ gridHeight = scrollableHeight(totalHeight, {pad, hasMoreAfter, reservePx})   ← scroller height
   └─ windowing over boxes → only [renderStart..renderEnd] Thumbs mount → GET /api/thumb/:id
```

### 2.1 Server: the feed query (`server/db/feed.js`)

- `/api/feed` returns a **windowed** page: given a `focusId` (an anchor row), it
  seeks the sorted/grouped/filtered order and returns up to `before` items before
  it and `after` items after it. `rowToItem(r, dims)` shapes each row into the
  client item: `{ id, name, size, mtimeMs, rating, preferredCover, width|null,
  height|null, taken_at, btime, kind, duration }`.
- Ordering is served by `groupBy` + `sort` (date/name/…) with generated
  expression indexes (see `docs/`/memory on "expression index rot"). The window is
  **relative to a focus row**, not an absolute offset — there is no
  "give me rows 60,000–60,600 of the current view" call today.
- `width`/`height` come straight from the `photos` row and are **`NULL` until
  enriched** (§2.3).

### 2.2 Client: the feed window (`ui/src/App.svelte`)

- `items[]` is the loaded window. `displayEntries[]` derives from it (adds
  placeholder bands for collapsed groups, stacks bursts, etc.).
- **Two transaction shapes own every window change** (consolidated in issue #42,
  guarding the #35/#36/#39 duplicate-key/scroll-jump bugs):
  - `withFeedTransaction(body)` — **replace** the window (filter/sort/groupBy
    change, fold, jump-to-group). Bumps `feedEpoch`, holds both fetching flags,
    re-checks `epoch !== feedEpoch` after every await.
  - `loadMore(direction, afterSize?)` — **extend** the window (infinite scroll).
    Appends `after` (adaptive page size, §4) or prepends `before`, with its own
    guard + scroll compensation.
- The invariant these protect: a fetch started against the OLD window must not
  splice its stale page into a REBUILT window (→ duplicate Svelte keys → the grid
  throws → "freeze"). Any new window logic must reuse one of the two transactions.

### 2.3 Metadata enrichment — the lazy dimension read (the crux)

This is the part most relevant to the design discussion, and the most
misunderstood.

- **The server does _not_ have every photo's dimensions stored.** It has the
  files, but `photos.width`/`height` are populated **on demand**:
  - `pendingMetaPhotos(db)` = `WHERE width IS NULL` (never attempted).
  - `storeMetadata()` writes `width`/`height`/`taken_at`/`duration` after a
    `processing.metadata()` call — a **sharp decode of the file header** (I/O +
    decode; the genuinely expensive step). `width = 0` is the "attempted but
    dimensionless" sentinel (RAW: sharp can't read it).
- **Who triggers the read:**
  - `enrichMeta(ids)` on the client requests `GET /api/meta?ids=…` for the
    just-loaded window's items whose `width == null`, then patches `items` in
    place and re-lays-out (`items = items`). It splits the batch so the tiles
    nearest the selection settle first, to minimize the visible reflow.
  - `POST /api/enrich` is a **background sweep** endpoint draining
    `pendingMetaPhotos` in batches — but it is effectively **inert** on the real
    library (a proactive on-open sweep was tried in 1c and reverted because it
    reflowed the live window and shifted date/album grouping). So in practice,
    dimensions are read **only for what you browse, paced to your scrolling.**
- **Net:** on the 114k library, ~100 rows have real dimensions; the rest are
  read just-in-time. Until a window's `/api/meta` returns, its layout uses
  `DEFAULT_RATIO = 1.5` and then reflows.

> **Design implication (already surfaced in discussion):** the layout _math_ is
> not the bottleneck — it's trivial and pure. The missing input is **every item's
> aspect ratio**, which requires reading every file's dimensions once. Precomputing
> and persisting those (a DOI/viewport-first sweep, stored in the SQLite
> speed-layer) is what would let the client compute a **true full-library layout**
> — and only then can the scroll height be real. "Compute the layout on the
> server" mostly relocates trivial math; "compute the _dimensions_ ahead of time"
> is the actual lever.

---

## 3. The layout pass (`ui/src/lib/layouts/`)

- **`justified.js`** — `justifiedLayout(items, {targetRowHeight, containerWidth,
  gap})`. Classic Flickr/Photos row-packing: accumulate items into a row until
  their natural widths (at `targetRowHeight`) fill `containerWidth`, then scale the
  row to justify. Pure function of **aspect ratios + container width + row height +
  gap**. **No `document`, no measurement.**
- **`sectionedJustified.js`** — wraps it to reserve full-width **header bands** at
  group boundaries and restart each section on a fresh row; also nests content by
  `depth` (indent). Adds constant `headerHeight`/`placeholderHeight`. Returns
  `{ boxes, headers, totalHeight }`, index-aligned 1:1 with input entries.
- **The only DOM-measured input is `containerWidth`** (`gridWidth`, a single
  integer via `bind:clientWidth`). Everything else is data or constants — so this
  module runs unchanged in Node (it already does in vitest).

### 3.1 Aspect-ratio construction (`App.svelte`)

```
baseRatio = (photo.width && photo.height) ? photo.width / photo.height : DEFAULT_RATIO(1.5)
aspectRatio = baseRatio + (2 * stackMarginPx) / rowHeight    // small cosmetic inflation for stack peek
```

Placeholder entries (collapsed-group bands, snapshot strips) instead carry an
explicit `height` from the renderer, computed before mount (the feed is
virtualized, so band heights must be known up front).

---

## 4. Windowing & scroll (`ui/src/lib/layouts/windowing.js` + `App.svelte`)

Pure helpers over the `boxes` array (all y-monotonic, so all binary searches):

| Helper | Purpose |
|---|---|
| `visibleRange(boxes, {scrollTop, viewportHeight, overscanPx})` | which `[start..end]` boxes to MOUNT (300px overscan) |
| `runwayPx(boxes, {scrollTop, viewportHeight})` | pixels of loaded content beyond each viewport edge — the real "how much road is left" |
| `topAnchorIndex` / `anchorScrollTop` | keep the eye-point tile fixed across a reflow (metadata/resize/zoom), so the guess→truth correction is invisible |
| `aheadRange` | indices just beyond the viewport in the travel direction — the predictive-prefetch target |
| `pageForRunway(boxes, {runwayPx, min, max})` | **adaptive loadMore page size** — scale the fetch to on-screen density so a fling doesn't out-run a fixed 60 (2.16.5) |
| `scrollableHeight(totalHeight, {pad, hasMoreAfter, reservePx})` | scroller height = content **+ a bounded bottom reserve while more remains**, so a fling doesn't clamp at the loaded floor (2.16.6) |

`updateVisibleRange()` (rAF-coalesced on scroll/resize) recomputes
`renderStart/renderEnd`, captures the scroll-anchor + velocity, fires predictive
prefetch (`planPrefetch` policy, `ui/src/lib/prefetchPolicy.js`), and triggers
`loadMore` when the pixel runway is short.

### 4.1 Why the scrollbar lies today

`gridHeight` (the scroller's height) = `layoutResult.totalHeight` (+ pad +
reserve). `totalHeight` is the height of the **loaded** boxes only. With 4,842 of
114,302 items loaded, the scroller is a few tens of thousands of px tall while the
true library is ~25× that. Therefore:

- **The scrollbar thumb size and position reflect the loaded window, not the
  library** — no true sense of size or "where am I in 114k".
- **A fast fling clamps at the loaded floor.** Native momentum stops there and
  does not resume when `loadMore` appends more a moment later → "it stopped
  because it thinks I reached the end." The 2.16.6 bottom reserve keeps a few
  screens of slack below so a fling glides instead of clamping, and `loadMore`
  backfills — a stopgap, not a true height.

### 4.2 What a "true" scroll would require (open design space)

To make the scroller reflect the whole library, the client needs the **total
height**, which needs **every item's height**, which needs **every item's aspect
ratio** (§2.3). And once the scroller is full-height, dragging to an arbitrary
offset needs **random-access windowing** — `/api/feed` must be able to load the
window around an arbitrary index/position, not just sequentially around a focus.
That last piece is the part that touches the guarded feed-window machinery (§2.2)
and is the main risk. These are the questions the current design discussion is
working through.

---

## 5. Endpoint reference

| Endpoint | Returns | Notes |
|---|---|---|
| `GET /api/feed?groupBy&filter&sort&focusId&before&after` | windowed `items[]` (+ focus) | window is **relative to a focus row**, not an absolute offset |
| `GET /api/meta?ids=1,2,3` | `[{id, takenAt, width, height, duration}]` | **reads dimensions on demand** (sharp) and persists them |
| `POST /api/enrich` | `202 {jobId}` | background sweep draining `WHERE width IS NULL`; currently inert in practice |
| `GET /api/enrich/pending` | `{pending}` | count still un-enriched |
| `GET /api/thumb/:id?size=…` | image bytes | generated on demand, `Cache-Control: immutable 1yr`; browser ~6-socket HTTP/1.1 limit is the thumbnail-throughput ceiling |

---

## 6. Key invariants any change must respect

1. **Folders on disk are the source of truth**; SQLite is a rebuildable cache keyed
   by `path + mtime + size`. Precomputed dimensions/geometry are cache, never
   authority.
2. **One of the two feed transactions owns every window change** (`withFeedTransaction`
   / `loadMore`) — issues #35/#36/#39/#42. New windowing (e.g. random-access jumps)
   must extend one of them, not hand-roll a third guard.
3. **The layout module is pure and framework-free** — width-dependent, but the only
   measured input is `containerWidth`. It runs in Node today (vitest), so "compute
   it elsewhere" is a data-plumbing question, not a rewrite.
4. **Never fail silently; never jump the user's eye-point.** Reflows are absorbed by
   scroll-anchoring; any new geometry source must preserve that.
