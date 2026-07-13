/**
 * Which subfolders a recursive add will actually import. The checklist is a
 * flat, depth-indented list (one row per directory the scan would turn into a
 * `folders` row), so the selection is just a Set of absolute paths.
 *
 * Every toggle returns a NEW Set: Svelte 4 reacts to reassignment, not to
 * mutation, so `selected = toggle(selected, p)` is the only thing that updates
 * the UI.
 *
 * @typedef {{path:string, relPath:string, depth:number, mediaCount:number}} SubdirRow
 */

/** @param {SubdirRow[]} dirs @returns {Set<string>} */
export function selectAll(dirs) {
  return new Set(dirs.map((d) => d.path));
}

/** @returns {Set<string>} */
export function selectNone() {
  return new Set();
}

/** @param {Set<string>} selected @param {string} path @returns {Set<string>} */
export function toggle(selected, path) {
  const next = new Set(selected);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/**
 * The checked paths, in list order — exactly what POST /api/scan's `dirs` wants.
 * @param {Set<string>} selected @param {SubdirRow[]} dirs @returns {string[]}
 */
export function selectedDirs(selected, dirs) {
  return dirs.filter((d) => selected.has(d.path)).map((d) => d.path);
}
