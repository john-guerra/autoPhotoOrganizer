# Fisheye snapshot view + 20k auto-albums default — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A width-fitted one-line "fisheye" strip (first few + middle fragment + last two) that stands in for a whole album/group; used **by default in AlbumsView** (making the 20k default safe) and as a 3rd feed-group state.

**Architecture:** A pure `sampleOffsets(count, slots)` picks which indices to show. A shared `SnapshotStrip.svelte` measures its width (ResizeObserver → slots) and renders the sampled thumbnails; it samples client-side from an explicit `ids` list (AlbumsView) or fetches `/api/group/sample` for a feed group. The feed gains a tri-state group header (expanded → snapshot → collapsed).

**Tech Stack:** Node ESM, Express, better-sqlite3, Svelte 4, d3-less; vitest. No new deps.

## Global Constraints

- ESM, no TypeScript (JSDoc). **Svelte 4** only (`export let`, `$:`, `createEventDispatcher`) — no runes.
- Tests: vitest, colocated `*.test.js`.
- Reuse the feed's existing dim/ordering machinery (`server/db/feed.js` `applySortToDims`/`resolveDimensions`) for `/api/group/sample` — do NOT hand-roll a parallel ORDER BY (CLAUDE.md debugging-discipline note).
- Server has no hot reload — restart `npm run dev` after server edits.
- **Decision:** AlbumsView uses snapshot strips **by default**; feed default landing stays **expanded**, snapshot is a cycle state.

---

## Slice A — AlbumsView snapshots + 20k (Tasks 1–6): shippable on its own

### Task 1: Sampling math (server + client port)

**Files:**

- Create: `server/db/sampleGroup.js`, `server/db/sampleGroup.test.js`
- Create: `ui/src/lib/snapshot.js`, `ui/src/lib/snapshot.test.js`

**Interfaces:**

- Produces: `sampleOffsets(count, slots) -> { offsets: number[], gaps: number[] }`. `offsets` strictly increasing indices in `[0,count)`; `gaps` = the positions _within `offsets`_ after which a real omission occurs (for rendering a `…`). Identical logic in both files (server is authoritative; client is a copy — note the twin in a comment, like `feed.js`/`tree.js` MONTH_NAMES).
- Also `slotCount(widthPx, thumbPx, gapPx) -> number` in `ui/src/lib/snapshot.js`: `Math.max(1, Math.floor((widthPx + gapPx) / (thumbPx + gapPx)))`.

- [ ] **Step 1: Write failing tests** for `sampleOffsets`:
  - `count <= slots` → `offsets = [0..count-1]`, `gaps = []`.
  - large: `count=1000, slots=12` → `offsets.length === 12`; first block `ceil((12-2)*0.6)=6` indices `0..5`; last two `998,999`; middle `12-2-6=4` indices strictly between 5 and 998, evenly spread; `offsets` strictly increasing, no dupes; `gaps` marks after index 5 (front→middle) and after index 9 (middle→last) in the offsets array (only where a true gap exists).
  - small `slots` (3 → front1/mid0/last2 or sensible; 4; 5) produce valid increasing offsets with no dupes and no out-of-range.
  - `count` just above `slots` (e.g. count=13, slots=12) still returns 12 distinct in-range offsets.
- [ ] **Step 2: Run** `npx vitest run server/db/sampleGroup.test.js ui/src/lib/snapshot.test.js` — expect FAIL.
- [ ] **Step 3: Implement** `sampleOffsets`:

```js
export function sampleOffsets(count, slots) {
  if (count <= 0 || slots <= 0) return { offsets: [], gaps: [] };
  if (count <= slots)
    return { offsets: Array.from({ length: count }, (_, i) => i), gaps: [] };
  const last = Math.min(2, slots);
  const first = Math.max(0, Math.ceil((slots - last) * 0.6));
  const mid = slots - last - first;
  const offsets = [];
  for (let i = 0; i < first; i++) offsets.push(i);
  // middle: evenly sample `mid` indices strictly inside (first-1, count-last)
  const lo = first,
    hi = count - last - 1; // inclusive middle band
  for (let k = 0; k < mid; k++) {
    const t = (k + 1) / (mid + 1);
    let idx = Math.round(lo + t * (hi - lo));
    if (offsets.length && idx <= offsets[offsets.length - 1])
      idx = offsets[offsets.length - 1] + 1;
    if (idx <= hi) offsets.push(idx);
  }
  for (let i = count - last; i < count; i++) offsets.push(i);
  // gaps: after any offset whose successor skips ≥2
  const gaps = [];
  for (let i = 0; i < offsets.length - 1; i++)
    if (offsets[i + 1] - offsets[i] > 1) gaps.push(i);
  return { offsets, gaps };
}
```

Copy verbatim into `ui/src/lib/snapshot.js`; add `slotCount` there.

- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** `feat(snapshot): pure sampleOffsets (first/middle/last) + client slotCount`.

### Task 2: `/api/group/sample` endpoint

**Files:** Modify `server/api.js`; test `server/api.test.js`.

**Interfaces:**

- Produces: `GET /api/group/sample?path=<json>&filter=&sort=&groupBy=&slots=` → `{ count, samples: Array<{...photo, offset, gapAfter}> }`. `samples` ordered by the same feed ORDER BY; ids equal the `sampleOffsets(count,slots)` slice of the group's ordered rows.

- [ ] **Step 1: Write failing test**: scan a temp folder; `GET /api/group/sample` for a `folder` group with `slots=5` returns `count` = folder size and `samples.length = min(count,5)`; sample ids match the same `LIMIT/OFFSET` slice of `GET /api/feed?groupBy=folder` order; `gapAfter` true only at real gaps.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** Parse `path` (JSON `{dimension,value}[]`), `slots` (int, clamp 1..64), reuse `parseFilterParam`, `parseSort`, and the same group-predicate + `applySortToDims(resolveDimensions(groupBy), sort)` ordering `getFeedPage` builds. Get `count` via the existing count query for the path. Compute `sampleOffsets(count, slots)`; fetch rows: one `LIMIT first OFFSET 0`, one `LIMIT 1 OFFSET k` per middle offset, one `LIMIT last OFFSET count-last`; map to `{...photo, offset, gapAfter: gaps.includes(indexInOffsets)}`. Prefer factoring a small `fetchGroupRowsAtOffsets(db, {path, filter, sort, groupBy, offsets})` helper in `server/db/feed.js` so the ORDER BY lives with the feed code, not duplicated.
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** `feat(snapshot): /api/group/sample returns first/middle/last of a group`.

### Task 3: Client fetch helper

**Files:** Modify `ui/src/lib/api.js`.

**Interfaces:**

- Produces: `fetchGroupSample({ path, filter, sort, groupBy, slots }) -> {count, samples}` (follows the existing `fetchFeed` param-building style, including `sort`/`filter` serialization already used there).

- [ ] **Step 1:** Implement following the existing helpers; no separate unit test (thin wrapper — covered live).
- [ ] **Step 2:** `npm run build` — expect success.
- [ ] **Step 3: Commit** `feat(snapshot): fetchGroupSample api helper`.

### Task 4: SnapshotStrip component

**Files:** Create `ui/src/lib/SnapshotStrip.svelte`.

**Interfaces:**

- Props (two shapes): `{ ids }` (ordered id list — samples client-side, no fetch) OR `{ groupPath, count, filter, sort, groupBy }` (fetches). Optional `thumbPx = 110`, `gapPx = 4`, `mtimeById` (Map, for cache-busting thumb URLs when available).
- Emits `select` with `{ id }` on thumbnail click.

- [ ] **Step 1: Implement** (Svelte 4):
  - `let el; let slots = 0;` measure via `ResizeObserver` in `onMount` (event-driven, no timers): on resize compute `next = slotCount(el.clientWidth, thumbPx, gapPx)`; only update `slots = next` when it actually changes (guard) — this is what re-triggers sampling/fetch.
  - Reactive: if `ids` given → `$: ({offsets, gaps} = sampleOffsets(ids.length, slots))`, `$: shown = offsets.map((o,i) => ({ id: ids[o], gapAfter: gaps.includes(i) }))`, `$: total = ids.length`. If `groupPath` given → on `slots`/`groupPath`/`filter`/`sort` change, `fetchGroupSample(...)` (guard against out-of-order responses with a request token), set `shown` from `samples` (`{id, gapAfter}`) and `total = count`.
  - Render a single non-wrapping flex row (`overflow:hidden`, fixed height ≈ `thumbPx`): for each shown item an `<img src={thumbUrl(item.id, 160, mtimeById?.get(item.id))} on:click>` (dispatch `select`); after an item with `gapAfter`, a `.gap` element showing `…`. A small trailing `.count` badge (e.g. `1000`) is fine.
  - Empty/`slots===0` → render an empty fixed-height container (so ResizeObserver has something to measure).
- [ ] **Step 2:** `npm run build` — expect success.
- [ ] **Step 3: Commit** `feat(snapshot): width-aware SnapshotStrip (ids or group-path source)`.

### Task 5: AlbumsView adoption (snapshots by default)

**Files:** Modify `ui/src/lib/AlbumsView.svelte`.

- [ ] **Step 1:** Replace the per-album `.album-grid` block (`{#each album.ids as id}<img class="album-thumb" …>`) with `<SnapshotStrip ids={album.ids} {mtimeById} on:select={(e) => dispatch("openphoto", e.detail)} />`. Import `SnapshotStrip`. Remove the now-unused `.album-thumb` img markup (keep `mtimeById`, already built at line ~44). This makes every album a one-line snapshot **by default**.
- [ ] **Step 2:** `npm run build` — expect success.
- [ ] **Step 3: Commit** `feat(albums): render each album as a fisheye snapshot strip by default`.

### Task 6: Raise the auto-albums limits

**Files:** Modify `server/api.js` (`/api/albums/timeline` `ALBUM_TIMELINE_MAX`), `ui/src/lib/AlbumsView.svelte` (default `limit`, help text).

- [ ] **Step 1:** Server: raise `ALBUM_TIMELINE_MAX` from `20000` to `200000` (DB-time safety only; rendering no longer scales with count). Keep the clamp + echo-back.
- [ ] **Step 2:** AlbumsView: change the default `limit` fallback from `2000` to `20000` (find the `limit` prop default / localStorage default). Update the `Max` input's `title`/help text — drop the "album grid isn't virtualized" caveat (snapshots fix it); mention strips render regardless of size.
- [ ] **Step 3:** Restart `npm run dev`; sanity `curl "http://localhost:4321/api/albums/timeline?limit=100000"` returns `limit:100000` (not clamped to 20000).
- [ ] **Step 4: Commit** `feat(albums): default 20k working set, raise server cap to 200k (snapshots make it cheap)`.

---

## Slice B — Feed tri-state (Tasks 7–8)

### Task 7: Feed group snapshot state

**Files:** Modify `ui/src/lib/displayEntries.js` (+ its test), `ui/src/App.svelte`.

**Interfaces:**

- Consumes: `SnapshotStrip`, `pathKey` (from `feed.js`).
- Produces: a per-group `snapshotGroupKeys` Set in App.svelte; a new `displayEntries` entry `kind: "snapshot"` emitted for a group in snapshot state (sibling of the existing `kind: "placeholder"` collapsed case); header click cycles expanded → snapshot → collapsed → expanded.

- [ ] **Step 1: Write failing test** in `displayEntries.test.js`: given a group whose key is in `snapshotGroupKeys`, `buildDisplayEntries(...)` emits one `kind:"snapshot"` entry carrying the group `path` + `count` (and suppresses the group's per-photo entries), analogous to the existing placeholder assertion. (Mirror the existing collapsed-group test.)
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the snapshot branch in `displayEntries.js` (follow the collapsed/placeholder code path already there). In App.svelte: add `snapshotGroupKeys` state; extend the header collapse control to cycle three states (expanded → snapshot → collapsed → expanded) with a distinct icon per state; render a `kind:"snapshot"` entry as one full-width row `<SnapshotStrip groupPath={entry.path} count={entry.count} filter={displayFilter} {sort} {groupBy} on:select={openLoupeById} />`. Reuse the existing collapsed-header suppression so the snapshot row owns its boundary label.
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(feed): snapshot as a third group state (expanded → snapshot → collapsed)`.

### Task 8: Live verification

- [ ] **Step 1:** `npm test` all green; `npm run dev` (real library).
- [ ] **Step 2 (AlbumsView):** open Albums, detect on a large working set (raise Max toward 20k); confirm each album renders as ONE snapshot strip (first/middle/last with `…`), the list is responsive (not thousands of `<img>`), and resizing the window re-slices strips without spamming `/api/group/sample` or re-render churn (Network tab).
- [ ] **Step 3 (Feed):** cycle a large day/month group expanded → snapshot → collapsed → expanded; confirm the strip fits the width with no wrap, shows first/middle/last, and clicking a strip thumb opens the loupe on that exact photo (verify order matches expanding the group).
- [ ] **Step 4:** Commit any fixes; open a PR from `feat/fisheye-snapshot`.

---

## Self-review notes

- Spec coverage: sampling (T1), endpoint (T2), api helper (T3), component (T4), AlbumsView default (T5), 20k/200k (T6), feed tri-state (T7), live verify (T8).
- `sampleOffsets` signature is defined once (T1) and consumed identically server-side (T2) and client-side (T4). Client copy is a deliberate twin (documented), matching the existing `feed.js`/`tree.js` MONTH_NAMES pattern.
- Slice A (T1–6) delivers the explicit "snapshots by default in auto albums" + 20k ask and is independently shippable; Slice B (T7–8) adds the broader feed 3rd-state.
