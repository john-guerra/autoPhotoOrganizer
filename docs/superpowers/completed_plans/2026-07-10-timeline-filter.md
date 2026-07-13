# Timeline Filter Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** An always-on brushable density timeline under the toolbar that adds a
`dateFrom`/`dateTo` facet to the shared filter spec, built on
`@john-guerra/d3-zoomable-axis`.

**Architecture:** One filter facet flows through the existing `buildFilter()` so
the feed/tree/counts all narrow for free. A new `/api/times` endpoint feeds the
timeline's KDE density (crossfilter on non-time facets). The widget emits
`[lo,hi]` → `filter.dateFrom/dateTo` via the existing `onFilterChange` path.

**Tech Stack:** Node/Express + better-sqlite3, Svelte 4, d3 v7, vitest.

## Global Constraints

- ESM everywhere; no TypeScript (JSDoc types).
- Svelte 4 (no runes): `export let`, `$:`, `createEventDispatcher`.
- Timestamp is always `COALESCE(photos.taken_at, photos.mtime)`.
- Do NOT hand-roll another `fetchingBefore/After/feedEpoch` copy — reuse
  `onFilterChange` (CLAUDE.md "no 7th copy").
- Tests colocated as `*.test.js`; server restart needed after backend edits.

---

### Task 1: Filter-spec date fields + dependency

**Files:**

- Modify: `ui/src/lib/filterSpec.js`
- Test: `ui/src/lib/filterSpec.test.js` (create if absent)
- Modify: `package.json` (dep install)

- [ ] Install: `npm install @john-guerra/d3-zoomable-axis` (retry if npm read lags publish; pin the resolved version).
- [ ] Add `dateFrom: null, dateTo: null` to `DEFAULT_FILTER`.
- [ ] `isActive(f)` returns true if `f.dateFrom != null || f.dateTo != null` (in addition to existing facets).
- [ ] Test: `isActive({...DEFAULT_FILTER, dateFrom: 1})` is true; default is false.
- [ ] Run `npm test`; commit.

### Task 2: Server buildFilter date-range clause

**Files:**

- Modify: `server/db/feed.js` (`buildFilter`)
- Test: `server/db/feed.test.js`

- [ ] In `buildFilter(spec)`, when `spec.dateFrom`/`spec.dateTo` are finite numbers, append
      `AND COALESCE(photos.taken_at, photos.mtime) >= ?` / `<= ?` with the bound(s) as params.
- [ ] Tests: both bounds, from-only, to-only, neither; AND-composes with a `rating` facet
      (assert the SQL contains the COALESCE clause and params are ordered correctly).
- [ ] `parseFilterParam` (server request→spec) coerces `dateFrom`/`dateTo` to finite numbers or null.
- [ ] Run `npm test`; commit.

### Task 3: workingSetTimes + GET /api/times

**Files:**

- Modify: `server/db/feed.js` (add `workingSetTimes`)
- Modify: `server/api.js` (add route)
- Test: `server/db/feed.test.js`, `server/api.test.js`

- [ ] `workingSetTimes(db, spec, cap = 12000)`: strips `dateFrom/dateTo` from `spec`, runs
      `SELECT COALESCE(taken_at,mtime) AS t … WHERE stale=0 AND (<other facets>) ORDER BY t`,
      computes exact `min`/`max`/`total`, and even-stride down-samples `t` to `cap`.
      Returns `{ times, total, min, max, sampled }`.
- [ ] `GET /api/times`: `parseFilterParam` → 400 on error; else `res.json(workingSetTimes(...))`.
- [ ] Tests: respects rating facet; ignores an incoming `dateFrom`; exact min/max; sampled when
      total>cap with exact total; empty set → `{times:[],total:0,min:null,max:null}`.
- [ ] Run `npm test`; restart dev server; commit.

### Task 4: api.js fetchTimes

**Files:**

- Modify: `ui/src/lib/api.js`

- [ ] `export async function fetchTimes(filter=null)` → `GET /api/times?filter=<json>`; returns JSON; throws on !ok (match existing helpers).
- [ ] Commit (folded into Task 5's commit is fine).

### Task 5: TimelineFilter.svelte

**Files:**

- Create: `ui/src/lib/TimelineFilter.svelte`

- [ ] Props: `min`, `max`, `times` (number[]), `value` ([fromMs,toMs]|null).
- [ ] Self-measure width via `bind:clientWidth` on the root (>0 before mounting the widget).
- [ ] Svelte action mounts `zoomableAxisInput(d3.scaleTime().domain([new Date(min),new Date(max)]), {orient:"bottom", length:width, value: value ? [new Date(value[0]),new Date(value[1])] : undefined, format:(d)=>d3.timeFormat("%b %e, %Y")(new Date(+d)), scent:{values:times, type:"violin", style:"kde", colorSelected:"#4c9aff"}})`.
- [ ] Listen for widget `"input"`; **debounce ~120ms**; dispatch `range` with `w.value.map(d=>+d)`.
      If the emitted range covers (≈) the full domain, dispatch `clear` instead.
- [ ] Action `update` rebuilds the widget when `min/max/times/width` change; `destroy` removes it.
- [ ] Verify the scaleTime/Date coercion against `d3ZoomableAxis/examples/test-local.html`; adjust if the widget wants numeric ms.

### Task 6: App.svelte integration

**Files:**

- Modify: `ui/src/App.svelte`, `ui/src/lib/api.js` (import)

- [ ] Import `TimelineFilter`, `fetchTimes`. State: `let timeMin=null, timeMax=null, timeTimes=[];`.
- [ ] `async function refreshTimes()` → `fetchTimes(non-time-facets-of displayFilter)`; set min/max/times.
      Reactive trigger keyed on the non-time facets + `libraryVersion` (crossfilter); guard against races with a small epoch.
- [ ] Call `refreshTimes()` in `onMount` and whenever rating/orientation or library change.
- [ ] Render `<TimelineFilter min={timeMin} max={timeMax} times={timeTimes} value={[filter.dateFrom,filter.dateTo]} on:range={(e)=>onFilterChange({...filter,dateFrom:e.detail[0],dateTo:e.detail[1]})} on:clear={()=>onFilterChange({...filter,dateFrom:null,dateTo:null})} />` in a new `.timeline-strip` between `</header>` and `.app-body`. Hide when `timeMin==null`.
- [ ] `.timeline-strip` CSS: full width, ~90px, dark, bottom border.
- [ ] Confirm the ✕ clear-filter path already zeroes dateFrom/dateTo (isActive true → button shows; onFilterChange with DEFAULT_FILTER clears).

### Task 7: Build, live-verify, commit

- [ ] `npm run build` (compile check) + `npm test` (all green).
- [ ] Live-verify (fresh browser tab, single-action evals — avoid chained clicks):
      brush→feed narrows + showing-count drops + 0 dup ids; zoom refines; Display vs Select;
      crossfilter reshape on rating≥4; reset via ✕.
- [ ] Commit; update tasks; note any follow-ups (album-boundary overlay is out of scope).
