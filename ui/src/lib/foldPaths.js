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
