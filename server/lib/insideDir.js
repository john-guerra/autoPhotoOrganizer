import { resolve, relative, isAbsolute } from "node:path";

/**
 * Is `child` the directory `parent` itself, or a descendant of it?
 *
 * A containment check on user-supplied paths arriving over HTTP, so this is a
 * security boundary, not a sanity check. A naive `child.startsWith(parent)`
 * has two holes this closes: a sibling sharing a name prefix (`/a/bc` is not
 * inside `/a/b`) and a `..` traversal that escapes (`/a/b/../../etc`). Both
 * are handled by resolving each side first and then asking whether the
 * relative path from parent to child stays put — a relative path that starts
 * with `..` (or is absolute, on a different Windows drive) has left the tree.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInsideDir(parent, child) {
  const p = resolve(parent);
  const c = resolve(child);
  if (p === c) return true;
  const rel = relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
