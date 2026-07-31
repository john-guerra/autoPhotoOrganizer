/**
 * The app's working scope: "show me only this". Two kinds, deliberately kept
 * distinct underneath one UI concept.
 *
 * - `folder`: a live path predicate (one string). Stays correct across rescans
 *   — photos scanned into the folder later appear inside the scope — and costs
 *   one WHERE over folders.abs_path.
 * - `ids`: an explicit, frozen photo-id set, stored server-side in the
 *   keep_scope table (the filter carries only a flag, so it can be any size),
 *   and read back from there on boot so it survives a reload too (#212).
 *   Scoping a whole folder this way would mean materializing every id in it,
 *   so the two kinds are NOT interchangeable — see the design doc.
 *
 * They are mutually exclusive by construction: a scope is one kind or neither.
 *
 * @typedef {{kind:"folder", path:string}} FolderScope
 * @typedef {{kind:"ids", ids:number[]}} IdsScope
 * @typedef {FolderScope|IdsScope|null} Scope
 */

/** Same key folder-focus already used, so an active focus survives the upgrade. */
export const LS_SCOPE_PATH = "autogallery.focusPath";

/** @returns {FolderScope} */
export function folderScope(path) {
  return { kind: "folder", path };
}

/** @returns {IdsScope|null} — an empty set is no scope, not an empty scope. */
export function idsScope(ids) {
  return ids && ids.length ? { kind: "ids", ids: [...ids] } : null;
}

/**
 * Project a scope onto the filter keys the feed/tree/counts understand.
 * @param {Scope} scope
 */
export function scopeFilterKeys(scope) {
  if (!scope) return {};
  if (scope.kind === "folder") return { folderPath: scope.path };
  return { keepScope: true };
}

/**
 * What the single scope chip renders. One chip, one exit — the two kinds differ
 * only in what they say.
 * @param {Scope} scope
 */
export function scopeChip(scope) {
  if (!scope) return null;
  if (scope.kind === "folder") {
    const name = scope.path.split("/").filter(Boolean).pop() || scope.path;
    return {
      icon: "▣",
      text: name,
      title: `Exit folder scope — back to the whole library (${scope.path})`,
    };
  }
  const n = scope.ids.length;
  return {
    icon: "●",
    text: `${n.toLocaleString()} photo${n === 1 ? "" : "s"}`,
    title: "Exit keep-only scope (back to the whole library)",
  };
}

/**
 * Persist the FOLDER scope only — an ids scope has nothing to persist here.
 *
 * Both kinds survive a reload as of #212, but by different routes, and the
 * asymmetry is the point: a folder scope is one string the browser can hold,
 * while an ids scope already lives in the server's keep_scope table. Writing a
 * browser-side copy of the latter would create a second answer to "what is the
 * working set", and those two answers diverging is precisely the bug — the
 * server kept the rows across a reload while the UI came back showing
 * everything. The client asks the server instead (`getScope`, restored in
 * App.svelte's `bootFeed`).
 *
 * Clearing LS_SCOPE_PATH for a non-folder scope is therefore not an oversight:
 * the two kinds are mutually exclusive, so an ids scope must leave no folder
 * path behind to be restored ahead of it on the next boot.
 * @param {Scope} scope
 */
export function persistScope(scope) {
  const st = storage();
  if (!st) return;
  if (scope?.kind === "folder") st.setItem(LS_SCOPE_PATH, scope.path);
  else st.removeItem(LS_SCOPE_PATH);
}

/** @returns {Scope} */
export function loadScope() {
  const st = storage();
  if (!st) return null;
  const path = st.getItem(LS_SCOPE_PATH);
  return path ? folderScope(path) : null;
}

/** Same guard as albumPrefs.js: vitest runs under `environment: "node"`, where
 * there is no localStorage, and a bare access would throw on import. */
function storage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}
