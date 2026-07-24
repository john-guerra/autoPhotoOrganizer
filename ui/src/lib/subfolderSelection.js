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
 * A `virtual` row is a media-less ANCESTOR (e.g. a "Cards" folder whose photos
 * all live in camera subfolders): it exists so the checklist can offer a parent
 * checkbox that toggles the whole subtree, but it never itself becomes a
 * `folders` row, so its own path is never part of the selection. Every
 * cascade/state decision therefore runs over the REAL (media) descendants only.
 *
 * @typedef {{path:string, relPath:string, depth:number, mediaCount:number, virtual?:boolean}} SubdirRow
 */

/**
 * The REAL (non-virtual) directories at `path` and beneath it — the ones that
 * actually get scanned. The trailing separator matters: a plain
 * startsWith(path) would also match a SIBLING that merely shares a name prefix
 * (/c/tripX is not inside /c/trip) — the same class of bug the server's
 * isInsideDir guard exists to prevent.
 * @param {SubdirRow[]} dirs @param {string} path @returns {string[]}
 */
function realDescendants(dirs, path) {
  const prefix = path.endsWith("/") ? path : path + "/";
  return dirs
    .filter((d) => !d.virtual && (d.path === path || d.path.startsWith(prefix)))
    .map((d) => d.path);
}

/** @param {SubdirRow[]} dirs @returns {Set<string>} */
export function selectAll(dirs) {
  return new Set(dirs.filter((d) => !d.virtual).map((d) => d.path));
}

/** @returns {Set<string>} */
export function selectNone() {
  return new Set();
}

/**
 * Toggle a folder and cascade to its subtree. Direction comes from the subtree,
 * not the row's own membership: if every real descendant is already checked the
 * click clears them, otherwise it checks them all. That's the standard tree
 * behaviour (clicking a full parent empties it; clicking an empty OR partial one
 * fills it) and the only thing that works for a virtual parent, whose own path
 * is never in the set.
 * @param {Set<string>} selected
 * @param {string} path
 * @param {SubdirRow[]} dirs
 * @returns {Set<string>}
 */
export function toggle(selected, path, dirs = []) {
  const next = new Set(selected);
  const reals = realDescendants(dirs, path);
  const allOn = reals.length > 0 && reals.every((p) => next.has(p));
  for (const p of reals) {
    if (allOn) next.delete(p);
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
  const reals = realDescendants(dirs, path);
  if (reals.length === 0) return "none";
  const on = reals.filter((p) => selected.has(p)).length;
  if (on === 0) return "none";
  if (on === reals.length) return "all";
  return "some";
}

/**
 * The checked paths, in list order — exactly what POST /api/scan's `dirs` wants.
 * @param {Set<string>} selected @param {SubdirRow[]} dirs @returns {string[]}
 */
export function selectedDirs(selected, dirs) {
  return dirs.filter((d) => selected.has(d.path)).map((d) => d.path);
}
