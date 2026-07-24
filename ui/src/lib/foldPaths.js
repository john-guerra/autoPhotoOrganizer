/**
 * Subtree-containment predicates for group folding (issue #124, extraction 2).
 *
 * Folding a group has THREE writers that must agree on what counts as "inside"
 * the thing being folded — `setGroupRenderer` (one group supersedes its
 * descendants), `cycleLeafPaths` (a virtual ancestor / Shift-click folding its
 * leaves) and, through it, `cycleGroupLeaves`. When only one of them applied the
 * containment test the feed drew a second strip inside a parent's, so the test
 * itself is the shared invariant — it belongs in one tested place, not inlined
 * three times.
 *
 * A group PATH is an ordered `Array<{dimension, value}>` from the top of the
 * grouping down. A group KEY is that same path after `pathKey()` — a JSON string
 * of `[[dimension, value], …]` — which is how collapsed/snapshot state is stored
 * so it can live in a `Set`. Both forms describe the same hierarchy; these
 * predicates answer "is X at or beneath `parent`?" for each.
 */

/** Is path `p` at or beneath `parent`? Both are `Array<{dimension, value}>`.
 * `parent` matches itself and every deeper path that shares its prefix; a
 * shorter or divergent path does not. */
export function isPathUnder(p, parent) {
  if (!Array.isArray(p) || p.length < parent.length) return false;
  return parent.every(
    (seg, i) => p[i]?.dimension === seg.dimension && p[i]?.value === seg.value
  );
}

/** Same test for a stored group KEY (`pathKey` output: a JSON string of
 * `[[dimension, value], …]`). A malformed key that won't parse is treated as not
 * under anything, rather than throwing. */
export function isKeyUnder(key, parent) {
  let pairs;
  try {
    pairs = JSON.parse(key);
  } catch {
    return false;
  }
  if (!Array.isArray(pairs) || pairs.length < parent.length) return false;
  return parent.every(
    (seg, i) => pairs[i]?.[0] === seg.dimension && pairs[i]?.[1] === seg.value
  );
}

/**
 * The pure decision behind every fold-icon click (feed header AND tree row,
 * #142): does this click aggregate the whole subtree as one band, fan out to
 * a per-leaf snapshot each, or just cycle this one group?
 *
 * `isParent` means "this path stands for more than itself" — it has
 * descendant folder groups of its own. Callers derive it as
 * `groupPaths.length > 1`, reusing the SAME `groupPaths` App.svelte's
 * `nestFolderHeaders` (feed headers) and `TreeNode.svelte` (tree rows) already
 * compute from folderTree.js's `descendantGroups` — `[path]` (length 1) for a
 * folder leaf AND for every non-folder dimension (year, camera, …, which never
 * nest), `[path, ...descendants]` or `[...descendants]` for a real or virtual
 * folder parent. No second "is this a folder" test is needed: only `folder`
 * ever produces a `groupPaths` longer than one.
 *
 * A LEAF (no descendant groups) ignores Shift entirely — "leaf" either way,
 * per the design's resolved Q3 ("shift on a leaf ≡ plain": nothing to fan out
 * beneath it, so the caller keeps its ordinary single-group cycle regardless
 * of the modifier).
 *
 * @param {{isParent: boolean, shiftKey: boolean}} args
 * @returns {"aggregate"|"perLeaf"|"leaf"}
 */
export function foldTargetFor({ isParent, shiftKey }) {
  if (!isParent) return "leaf";
  return shiftKey ? "perLeaf" : "aggregate";
}
