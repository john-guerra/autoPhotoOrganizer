/**
 * Pure tree-local expand-state helpers for TreeSidebar/TreeNode — track
 * which paths currently have their children fetched and shown, entirely
 * independent of collapsedPaths (which controls what the FEED excludes;
 * see docs/superpowers/specs/2026-07-06-tree-sidebar-design.md's "Two
 * distinct kinds of state").
 *
 * WARNING: `treeKey` is NOT interchangeable with feed.js's `pathKey`. This one
 * joins `dimension=value` on '>'; `pathKey` JSON-encodes the pairs. They produce
 * different strings for the same path, so a Set keyed by one CANNOT be probed
 * with the other (that silently never matches — it made every snapshot group
 * render as "collapsed" in the sidebar). Compare path arrays with treeKey on
 * both sides, and use pathKey for anything App.svelte keyed with pathKey.
 */

/** @param {Array<{dimension:string,value:string}>} path @returns {string} */
export function treeKey(path) {
  return path.map((p) => `${p.dimension}=${p.value}`).join(">");
}

/**
 * Resets every currently-expanded descendant of `path` back to collapsed —
 * "fold all descendants." A descendant's key starts with this path's own
 * key followed by the '>' separator, so string-prefix matching identifies
 * them without needing the tree's actual node objects. The separator
 * matters: without it, "folder=/a" would incorrectly match a sibling key
 * like "folder=/a2". `path` itself is left untouched — the caller decides
 * separately whether the clicked node stays expanded or collapses too.
 * @param {Set<string>} expandedKeys
 * @param {Array<{dimension:string,value:string}>} path
 * @returns {Set<string>}
 */
export function collapseDescendants(expandedKeys, path) {
  const prefix = treeKey(path) + ">";
  const next = new Set();
  for (const key of expandedKeys) {
    if (!key.startsWith(prefix)) next.add(key);
  }
  return next;
}
