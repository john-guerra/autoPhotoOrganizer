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

/**
 * If `path` is inside (at, or a descendant of) any subtree currently folded
 * as one AGGREGATE unit (#142), the key of that aggregated ANCESTOR — the
 * key jumpToPath must actually look for in the DOM, since a descendant's own
 * placeholder row doesn't exist once an ancestor stands for its whole
 * subtree. `null` if `path` isn't under anything aggregated.
 *
 * `aggregateKeys` holds each aggregated ancestor's OWN `pathKey` — the
 * identical string its plain leaf entry would have (`pathKey` encodes only
 * `[dimension, value]`; the `subtree` flag never changes it — see
 * App.svelte's `aggregateKeys` doc comment) — so this can't be answered by
 * `isPathUnder`/`isKeyUnder`'s ARRAY-prefix test: a folder always occupies
 * exactly one `{dimension:"folder"}` path segment, however deep it sits
 * (folderTree.js's trie, not extra path length, carries the nesting), so a
 * descendant folder's path is the SAME LENGTH as its ancestor's, just a
 * different string value.
 *
 * Folder nesting is a fact about the `abs_path` STRING instead (see
 * folderTree.js's `chainTo`/`relativeTo`, the existing precedent for this
 * exact test): "/L/Cards/Cam1" is under "/L/Cards" because the string is a
 * `/`-prefix of it, not because of array shape.
 *
 * Every OTHER groupBy segment (year, camera, … anything above the folder
 * dimension) must match EXACTLY — an aggregated "2024/Cards" must not also
 * swallow "2023/Cards", which merely shares a folder value.
 *
 * @param {Array<{dimension:string,value:string}>} path
 * @param {Set<string>} aggregateKeys  pathKey() of every aggregated ancestor
 * @returns {string|null}
 */
export function aggregateAncestorKeyFor(path, aggregateKeys) {
  if (!Array.isArray(path) || !path.length || !aggregateKeys?.size) {
    return null;
  }
  const folderIdx = path.findIndex((seg) => seg?.dimension === "folder");
  if (folderIdx === -1) return null;
  const value = path[folderIdx]?.value;
  if (value == null) return null;

  for (const rawKey of aggregateKeys) {
    let pairs;
    try {
      pairs = JSON.parse(rawKey);
    } catch {
      continue;
    }
    if (!Array.isArray(pairs) || pairs.length !== folderIdx + 1) continue;
    const prefixMatches = path
      .slice(0, folderIdx)
      .every(
        (seg, i) =>
          pairs[i]?.[0] === seg.dimension && pairs[i]?.[1] === seg.value
      );
    if (!prefixMatches) continue;
    const ancestorValue = pairs[folderIdx]?.[1];
    if (ancestorValue == null) continue;
    if (value === ancestorValue || value.startsWith(`${ancestorValue}/`)) {
      return rawKey;
    }
  }
  return null;
}

/**
 * Is `path` inside (at, or a descendant of) any aggregated subtree? Used by
 * `jumpToPath`'s folded-check: a jump/scan can target a real folder group
 * whose OWN collapsedPaths entry was purged by `cycleSubtreeAggregate`
 * because an ANCESTOR now stands for its whole subtree (it has no entry of
 * its own to find) — so the 3-arg `rendererIdFor` alone reports "grid" for
 * it, and this closes that gap. See `aggregateAncestorKeyFor` for the actual
 * containment test.
 *
 * @param {Array<{dimension:string,value:string}>} path
 * @param {Set<string>} aggregateKeys
 * @returns {boolean}
 */
export function isPathUnderAggregate(path, aggregateKeys) {
  return aggregateAncestorKeyFor(path, aggregateKeys) != null;
}
