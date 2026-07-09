/**
 * Pure feed-window logic: no DOM, no Svelte, no fetch. Same shape as
 * displayEntries.js/bursts.js — App.svelte composes these.
 */

// Month-of-year full names. The `month` dimension is now "%m" ("01".."12"),
// aggregating all Decembers regardless of year — so it labels as the month name.
// Kept in sync with server/db/tree.js's twin (no shared server/client module).
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** @param {string} dimension @param {string} value @returns {string} */
export function formatGroupValue(dimension, value) {
  if (value === "") return "Unknown";
  if (dimension === "month") return MONTH_NAMES[Number(value) - 1] ?? value;
  return value;
}

/**
 * @typedef {{items: object[], hasMoreBefore: boolean, hasMoreAfter: boolean}} FeedWindow
 */

/**
 * @param {FeedWindow} window
 * @param {{items: object[]}} page
 * @param {'before'|'after'} direction
 * @param {number} requestedCount how many were asked for in this direction
 * @returns {FeedWindow}
 */
export function mergeFeedPage(window, page, direction, requestedCount) {
  const existingIds = new Set(window.items.map((i) => i.id));
  const fresh = page.items.filter((i) => !existingIds.has(i.id));
  const items =
    direction === "after"
      ? [...window.items, ...fresh]
      : [...fresh, ...window.items];
  const gotFullPage = page.items.length >= requestedCount;
  return {
    items,
    hasMoreBefore:
      direction === "before" ? gotFullPage : window.hasMoreBefore,
    hasMoreAfter: direction === "after" ? gotFullPage : window.hasMoreAfter,
  };
}

/**
 * Walks the loaded, already-ordered item array and emits one header per
 * grouping-level boundary, outermost dimension first — mirroring how a
 * change at an outer level always implies every inner level "restarts"
 * (matches server/db/feed.js's ORDER BY: outer dimensions partition the
 * whole array into contiguous runs, inner dimensions partition within).
 * @param {Array<{groupValues: Record<string,string>}>} items
 * @param {string[]} groupBy
 * @returns {Array<{index:number, depth:number, dimension:string, value:string, label:string}>}
 */
export function deriveSectionHeaders(items, groupBy) {
  const headers = [];
  const lastSeen = new Array(groupBy.length).fill(undefined);
  items.forEach((item, index) => {
    let changedAbove = false;
    groupBy.forEach((dimension, depth) => {
      const value = item.groupValues[dimension];
      if (changedAbove || value !== lastSeen[depth]) {
        lastSeen[depth] = value;
        changedAbove = true;
        headers.push({
          index,
          depth,
          dimension,
          value,
          label: formatGroupValue(dimension, value),
        });
      }
    });
  });
  return headers;
}

/**
 * Annotates each header (as produced by deriveSectionHeaders) with its full
 * ancestor path — the {dimension,value} pair for itself and every shallower
 * currently-open header, in depth order. Needed to fetch this header's photo
 * count from the tree API (`getTreeNode`'s `path` param is exactly this
 * shape, scoped to the header's own depth). Headers arrive already in index
 * order with the same "outer dimension change resets every inner one"
 * structure the tree itself has, so a single pass with a depth-indexed stack
 * reconstructs each one's path with no lookahead.
 * @param {Array<{depth:number, dimension:string, value:string}>} headers
 * @returns {Array<{depth:number, dimension:string, value:string, path: Array<{dimension:string,value:string}>}>}
 */
export function computeHeaderPaths(headers) {
  const current = [];
  return headers.map((h) => {
    current.length = h.depth;
    current.push({ dimension: h.dimension, value: h.value });
    return { ...h, path: [...current] };
  });
}

/**
 * A stable string key for a group path (a `{dimension,value}[]`), for use as
 * a cache/Map key or a Svelte `{#each}` key. Encodes dimension AND value in
 * order so two paths collide iff they're the same hierarchy node — a folder
 * value like `/a/b` can contain any character, so this JSON-encodes rather
 * than joining on a delimiter that a value might itself contain.
 * @param {Array<{dimension:string, value:string}>} path
 * @returns {string}
 */
export function pathKey(path) {
  return JSON.stringify(path.map((p) => [p.dimension, p.value]));
}

/**
 * The distinct *parent* paths of a set of headers (each header's own path
 * minus its last element), deduped by pathKey, in first-appearance order.
 * A header's photo count comes from the tree API's node list for its parent
 * path (one GROUP BY that returns every sibling's count at once), so callers
 * fetch one parent, not one header — a folder with 30 date-subgroups is a
 * single query. A depth-0 header's parent is the empty root path `[]`, which
 * is a valid, needed query (top-level counts), so it's kept, not dropped.
 * @param {Array<{path: Array<{dimension:string, value:string}>}>} headers
 * @returns {Array<Array<{dimension:string, value:string}>>}
 */
export function headerParentPaths(headers) {
  const seen = new Set();
  const parents = [];
  for (const h of headers) {
    const parent = h.path.slice(0, -1);
    const key = pathKey(parent);
    if (seen.has(key)) continue;
    seen.add(key);
    parents.push(parent);
  }
  return parents;
}

/**
 * Drops any header deriveSectionHeaders would otherwise emit at or below a
 * placeholder's own collapse depth — the placeholder already renders its
 * own folded label/count (see App.svelte's grid template), so a normal
 * sticky-header band there would duplicate the same boundary.
 * @param {Array<{index:number, depth:number}>} headers
 * @param {Array<{kind:string, item:object}>} displayEntries
 * @returns {Array<{index:number, depth:number, dimension:string, value:string, label:string}>}
 */
export function suppressPlaceholderHeaders(headers, displayEntries) {
  return headers.filter((h) => {
    const entry = displayEntries[h.index];
    if (entry?.kind !== "placeholder") return true;
    return h.depth < entry.item.path.length - 1;
  });
}

/**
 * The id of the nearest non-placeholder item from one end of the array —
 * used as a keyset seek anchor for loadMore, since a placeholder's
 * synthetic id has no corresponding photos row for the server to look up a
 * position from.
 * @param {Array<{id: number|string, collapsed?: boolean}>} items
 * @param {'start'|'end'} from
 * @returns {number|string|null}
 */
export function nearestRealItemId(items, from) {
  const seq = from === "end" ? [...items].reverse() : items;
  const real = seq.find((it) => !it.collapsed);
  return real ? real.id : null;
}
