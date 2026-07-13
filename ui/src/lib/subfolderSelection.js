/**
 * Which subfolders a recursive add will actually import. The checklist is a
 * flat, depth-indented list (one row per directory the scan would turn into a
 * `folders` row), so the selection is just a Set of absolute paths.
 *
 * Toggling a row cascades to its whole subtree: checking a parent pulls in
 * everything beneath it, unchecking it drops the lot. That's what makes the
 * flat list usable on a deep card — you shouldn't have to click twenty boxes to
 * take a year, or to drop one.
 *
 * Every toggle returns a NEW Set: Svelte 4 reacts to reassignment, not to
 * mutation, so `selected = toggle(selected, p, dirs)` is the only thing that
 * updates the UI.
 *
 * @typedef {{path:string, relPath:string, depth:number, mediaCount:number}} SubdirRow
 */

/**
 * `path` and every directory beneath it. The trailing separator matters: a
 * plain startsWith(path) would also match a SIBLING that merely shares a name
 * prefix (/c/tripX is not inside /c/trip) — the same class of bug the server's
 * isInsideDir guard exists to prevent.
 * @param {SubdirRow[]} dirs @param {string} path @returns {string[]}
 */
function subtree(dirs, path) {
  const prefix = path.endsWith("/") ? path : path + "/";
  return dirs
    .map((d) => d.path)
    .filter((p) => p === path || p.startsWith(prefix));
}

/** @param {SubdirRow[]} dirs @returns {Set<string>} */
export function selectAll(dirs) {
  return new Set(dirs.map((d) => d.path));
}

/** @returns {Set<string>} */
export function selectNone() {
  return new Set();
}

/**
 * Toggle a folder and cascade to its descendants. The folder's own current
 * state decides the direction: checking it checks the subtree, unchecking it
 * clears the subtree.
 * @param {Set<string>} selected
 * @param {string} path
 * @param {SubdirRow[]} dirs
 * @returns {Set<string>}
 */
export function toggle(selected, path, dirs = []) {
  const next = new Set(selected);
  const turningOff = next.has(path);
  for (const p of subtree(dirs, path)) {
    if (turningOff) next.delete(p);
    else next.add(p);
  }
  return next;
}

/**
 * How a row's checkbox should render: "all" (checked), "none" (unchecked), or
 * "some" (indeterminate) when the folder and its subtree disagree.
 *
 * Without "some", a parent whose child you just excluded would still show a
 * full checkmark — the box would be lying about what's coming in. A leaf has no
 * subtree to disagree with, so it's only ever all or none.
 * @param {Set<string>} selected
 * @param {string} path
 * @param {SubdirRow[]} dirs
 * @returns {"all"|"none"|"some"}
 */
export function subtreeState(selected, path, dirs = []) {
  const paths = subtree(dirs, path);
  const on = paths.filter((p) => selected.has(p)).length;
  if (on === 0) return "none";
  if (on === paths.length) return "all";
  return "some";
}

/**
 * The checked paths, in list order — exactly what POST /api/scan's `dirs` wants.
 * @param {Set<string>} selected @param {SubdirRow[]} dirs @returns {string[]}
 */
export function selectedDirs(selected, dirs) {
  return dirs.filter((d) => selected.has(d.path)).map((d) => d.path);
}
