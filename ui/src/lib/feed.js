/**
 * Pure feed-window logic: no DOM, no Svelte, no fetch. Same shape as
 * displayEntries.js/bursts.js — App.svelte composes these.
 */

/** @param {string} dimension @param {string} value @returns {string} */
export function formatGroupValue(_dimension, value) {
  return value === "" ? "Unknown" : value;
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
    return h.depth < entry.item.path.length;
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
