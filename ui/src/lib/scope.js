/**
 * The app's working scope: "show me only this". Two kinds, deliberately kept
 * distinct underneath one UI concept.
 *
 * - `folder`: a live path predicate (one string). Stays correct across rescans
 *   — photos scanned into the folder later appear inside the scope — costs one
 *   WHERE over folders.abs_path, and survives a reload.
 * - `ids`: an explicit, frozen photo-id set, stored server-side in the
 *   keep_scope table (the filter carries only a flag, so it can be any size).
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
  return {
    icon: "●",
    text: `${scope.ids.length.toLocaleString()} photos`,
    title: "Exit keep-only scope (back to the whole library)",
  };
}

/**
 * Folder scope persists across a reload; an ids scope deliberately does not
 * (it never did — keepIds reset to null on load even though the server-side
 * keep_scope row outlives the page).
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
