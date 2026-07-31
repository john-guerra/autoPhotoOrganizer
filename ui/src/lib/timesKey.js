/**
 * The cache key for the toolbar timeline's density fetch (#194, #246).
 *
 * The timeline refetches only when this key changes. That is the right shape —
 * brushing the time range must NOT refetch, or the histogram you are brushing
 * within collapses under you — but it makes the key's completeness
 * load-bearing: anything the key cannot see is a change the timeline will
 * silently ignore.
 *
 * ## The trap this function exists to name
 *
 * An ids scope ("keep only") is projected onto the filter as a **constant**:
 * `scopeFilterKeys` returns `{ keepScope: true }` for every working set,
 * because the ids themselves live server-side in `keep_scope` (that is what
 * lets a scope be any size without travelling in a query param — see
 * `scope.js`). So working set A and working set B stringify **identically**,
 * the guard suppresses the refetch, and the timeline keeps plotting the
 * previous set's dates and density.
 *
 * That was #246. The obvious fix — put the ids in the key — throws away the
 * exact property `keep_scope` exists to provide, and would put 100,000 ids
 * through `JSON.stringify` on every derive. So the scope contributes a
 * **version counter** instead: `App.svelte` bumps `scopeVersion` in
 * `applyScope`, the single funnel through which the working set changes.
 *
 * A folder scope needs no such help — it carries a path string that varies on
 * its own — but it goes through the same counter anyway, because a rule with
 * an exception is a rule someone will get wrong.
 *
 * ## Adding to the key
 *
 * If you introduce another piece of state the density depends on, it belongs
 * here, and it must be something that actually CHANGES when that state does.
 * A boolean flag standing in for an unbounded set is the bug above.
 *
 * @param {object} timesFilter the display filter with the time facet stripped
 * @param {number} libraryVersion bumped when the library's contents change
 * @param {number} scopeVersion bumped when the working set is replaced
 * @returns {string}
 */
export function timesCacheKey(timesFilter, libraryVersion, scopeVersion) {
  return `${JSON.stringify(timesFilter)}|${libraryVersion}|${scopeVersion}`;
}
