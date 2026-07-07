# Alt+Left/Right group navigation — Design

Status: Approved, ready for implementation plan
Date: 2026-07-07

## Context & problem

The user asked for a way to jump to the next/previous "group" (section
header boundary) via Alt+Left/Right, rather than stepping photo-by-photo.
An initial client-only attempt (searching `layoutResult.headers`, the
already-loaded section boundaries, and falling back to fetching more pages
via the existing `loadMore` when none was found in the loaded window) was
built and tested live, but proved unworkable against the user's real
library: one real folder holds 10,172 photos, almost all from the same
year — with `groupBy=["folder","year"]`, jumping from the first photo
requires searching past most or all of that folder's photos before finding
any boundary. A client-side "keep fetching pages until a boundary shows
up" loop would need to load thousands of intermediate photos into the
browser just to skip past them — slow, wasteful, and it hit its own safety
cap without finding anything in testing.

## Goal

Alt+Right jumps to the next section-header boundary; Alt+Left to the
previous. "Boundary" means any depth of the current `groupBy` — e.g. with
`groupBy=["folder","year"]`, the next year within the same folder, rolling
up to the next folder once the last year in the current one is passed.
Resolved via a single indexed SQL query, so it works instantly regardless
of how many photos sit between the current position and the next
boundary — a folder with 10,000 photos and one with 10 photos are both a
single query away.

## Server: `findGroupBoundary`

A new function in `server/db/feed.js`, alongside `getFeedPage`, reusing
its composite-ordering machinery directly rather than duplicating it:

```js
/**
 * Find the id of the first real row in the next/previous DIFFERENT group
 * after/before focusId's own position, at any dimension depth — e.g. the
 * next year within the same folder, or the next folder once the last
 * year in the current one is passed. A single indexed query, regardless
 * of how many rows sit between focusId and the boundary — the client-side
 * alternative (paging through every intermediate row) doesn't scale to a
 * 10,000-photo folder.
 * @param {import("better-sqlite3").Database} db
 * @param {{groupBy:string[], collapsed?:Array<Array<{dimension:string,value:string}>>, focusId:number, direction:"next"|"prev"}} opts
 * @returns {{id:number}|null}
 */
export function findGroupBoundary(
  db,
  { groupBy, collapsed = [], focusId, direction }
) {
  const dims = resolveDimensions(groupBy);
  const seekDims = [
    ...dims,
    { name: "__id", expr: "photos.id", direction: "ASC" },
  ];
  const wantAfter = direction === "next";
  const selectDimCols = dims.map((d, i) => `${d.expr} AS dim${i}`).join(", ");

  const focusRow = db
    .prepare(
      `SELECT photos.id, ${selectDimCols}
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.id = ?`
    )
    .get(focusId);
  if (!focusRow) throw new Error(`focusId ${focusId} not found`);
  const focusValues = dims
    .map((_, i) => focusRow[`dim${i}`])
    .concat(focusRow.id);

  const { sql: exclSql, params: exclParams } = exclusionClause(
    collapsed,
    dims
  );
  const { sql: seekSql, params: seekParams } = seekCondition(
    seekDims,
    focusValues,
    wantAfter
  );
  // "Not the focus row's own full group" — collapsedPathCondition already
  // builds exactly this NOT(...) shape for an arbitrary dimension/value
  // path; the focus row's own current groupBy values are just another
  // path to exclude, reused verbatim rather than duplicating the SQL.
  const currentGroupPath = groupBy.map((name, i) => ({
    dimension: name,
    value: focusRow[`dim${i}`],
  }));
  const { sql: notCurrentSql, params: notCurrentParams } =
    collapsedPathCondition(currentGroupPath, dims);

  const orderCols = seekDims
    .map((d, i) => {
      const col = i < dims.length ? `dim${i}` : "photos.id";
      const dir = wantAfter
        ? d.direction
        : d.direction === "ASC"
          ? "DESC"
          : "ASC";
      return `${col} ${dir}`;
    })
    .join(", ");

  const row = db
    .prepare(
      `SELECT photos.id, ${selectDimCols}
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.stale = 0 AND (${exclSql}) AND (${seekSql}) AND (${notCurrentSql})
       ORDER BY ${orderCols}
       LIMIT 1`
    )
    .get(...exclParams, ...seekParams, ...notCurrentParams);
  return row ? { id: row.id } : null;
}
```

`resolveDimensions`, `seekCondition`, `exclusionClause`,
`collapsedPathCondition` are all existing, already-tested functions in
this same file — this reuses them exactly as `getFeedPage` does, adding
only the one new "not the current row's own group" clause. Returns `null`
when there's no next/previous group (already at the first/last group in
the whole library, given the current `collapsed` exclusions) — the client
treats this as "nothing to jump to," a no-op.

## API route

`GET /api/feed/boundary?groupBy=folder,year&collapsed=...&focusId=123&direction=next`
→ `{ id: number|null }`. Thin wrapper: parses `groupBy`/`collapsed` exactly
like the existing `GET /api/feed` route already does (same query-param
parsing, reused not duplicated), validates `direction` is `"next"` or
`"prev"` (400 otherwise), calls `findGroupBoundary`, returns the result.
404 if `focusId` doesn't resolve to a real photo (mirrors `getFeedPage`
throwing for an unknown `focusId` today — the route's existing try/catch
around `getFeedPage` errors already turns that into a controlled response
pattern to follow here too).

## Client

`ui/src/lib/api.js` gains `fetchGroupBoundary({groupBy, collapsed, focusId, direction})`,
mirroring `fetchFeed`'s existing param-building pattern.

In `ui/src/App.svelte`'s `onKeydown`: the browser-shortcut early return
(`if (e.metaKey || e.ctrlKey || e.altKey) return;`) is narrowed to let
Alt+ArrowLeft/Right through specifically, since those two combos aren't
reserved by any browser/OS shortcut this app needs to defer to. A new
handler, gated on `e.altKey && (key === "ArrowRight" || key === "ArrowLeft")`:
takes the current `displayEntries[selected]`'s photo id as `focusId`, calls
`fetchGroupBoundary` with `direction: "next"` (Right) or `"prev"` (Left).
If it returns an id, fetch a window centered on that id — reusing the
exact "before+after centered on a known focusId" pattern `onGroupByChange`
already implements (fetch `before: PAGE_SIZE/2` and `after: PAGE_SIZE/2`
around it, splice `beforePage + [focusItem] + afterPage`, resolve the new
`selected` via `displayEntries.findIndex` matching the returned id, falling
back through `nextSelectable` in the unlikely case it landed on a
placeholder) — then scroll there via the existing `scrollToSection`,
using the newly-loaded window's own computed header position for that
boundary. If `fetchGroupBoundary` returns `null`, no-op (already at the
first/last group). Works in both grid and loupe modes, since both already
share the same `selected` state (matching how rating/cover-toggle already
work identically in both).

## Testing

- `server/db/feed.test.js`: `findGroupBoundary` — finds the next/previous
  boundary at the innermost dimension (e.g. next year, same folder); rolls
  up to the next outer dimension when the inner one is exhausted (e.g.
  next folder once the last year in the current folder is passed); returns
  `null` at the true start/end of the library; correctly skips
  already-collapsed sections (a `collapsed` path between the focus and the
  next real boundary must not be treated as a stopping point, matching
  `getFeedPage`'s own exclusion behavior).
- `server/api.test.js`: `GET /api/feed/boundary` — 200 with a real id for
  a normal case, `{id: null}` at the library's edge, 400 for an invalid
  `direction`, 404 for an unknown `focusId`.
- No automated test for the `onKeydown` change (this project's established
  convention for Svelte components) — verified manually against the real
  library, specifically re-testing the exact scenario that broke the
  client-only attempt (jumping from the start of the 10,172-photo folder).

## Out of scope

- Any new visual "jump" affordance (button, breadcrumb) — keyboard-only,
  matching the user's original ask.
- Changing what counts as a "group" — still exactly the current `groupBy`
  array, at any depth, per the earlier confirmed scope decision.
- Any change to `onGroupByChange`/`loadInitialFeed`/`jumpToPath`'s own
  behavior — this adds a new, separate keyboard-triggered path alongside
  them, reusing their "center on a known focusId" pattern rather than
  modifying it.

## Validation

After implementation: from the very first photo in the 10,172-photo
`fotos_bk` folder (the exact case that broke the earlier client-only
attempt), press Alt+Right and confirm it jumps to the correct next
boundary (likely a different folder or year) near-instantly, with no
console errors and no unnecessary intermediate fetches. Press Alt+Left
from there and confirm it returns to the correct previous boundary. Test
at both grid-level and inside the Loupe view. Test with an active
`collapsed` section between the current and next boundary, confirming it's
correctly skipped over rather than treated as a stop.
