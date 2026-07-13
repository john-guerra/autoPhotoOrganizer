/**
 * What ⌘A / ⌘⇧A should do *next*.
 *
 * Both shortcuts escalate: the first press acts on the current group, a second
 * press reaches for everything the filters show. The escalation is driven by
 * STATE, not by a timer — "you already have this whole group" is what makes the
 * next press mean "then you must want more", so there's no settle window to get
 * wrong and no double-tap speed to learn.
 *
 * Reaching for every photo in the library is the surprising one, so it doesn't
 * happen on a keystroke: it returns "prompt", and the caller shows an inline
 * confirmation (never a blocking confirm() — see #97). Pressing the same
 * shortcut again while that prompt is up is the confirmation.
 *
 * @typedef {"select"|"deselect"} BulkKind
 * @typedef {null|"select"|"deselect"} Pending  the prompt currently showing
 * @typedef {"group"|"prompt"|"confirm"} BulkAction
 */

/**
 * @param {BulkKind} kind
 * @param {{pending: Pending, hasGroup: boolean, groupFullySelected?: boolean, groupHasSelection?: boolean}} state
 * @returns {BulkAction}
 *   "group"   — act on the current group alone
 *   "prompt"  — ask before touching everything the filters show
 *   "confirm" — the prompt is already up and this press confirms it
 */
export function nextBulkAction(kind, state) {
  const { pending, hasGroup } = state;

  // The prompt is up and the user pressed the same shortcut again: that's a yes.
  if (pending === kind) return "confirm";

  // No group to act on (nothing focused, or a flat ungrouped feed) — the group
  // step has nothing to do, so go straight to asking about the whole set.
  if (!hasGroup) return "prompt";

  if (kind === "select") {
    // Already hold the entire group? Then the only thing left to want is more.
    return state.groupFullySelected ? "prompt" : "group";
  }

  // Deselect: nothing of this group is in the selection, so removing it again
  // is a no-op — escalate to "remove everything shown" instead.
  return state.groupHasSelection ? "group" : "prompt";
}

/**
 * Undo a bulk selection change: the selection becomes EXACTLY what the snapshot
 * held, replacing whatever is selected now.
 *
 * It must not union. Unioning happens to look right for Clear (you're merging
 * into an empty set), but it makes undoing a select-all a no-op — you'd get
 * everything-you-had ∪ everything, which is everything. "Undo" means "put it
 * back", not "add the old one to the new one".
 *
 * @param {Set<number>|Iterable<number>|null} snapshot
 * @returns {Set<number>}
 */
export function restoreSelection(snapshot) {
  return new Set(snapshot ?? []);
}

/**
 * What to call the current group in the status line ("Selected 6 in DCIM").
 *
 * A group path is [{dimension, value}] — NOT strings, so a naive String(last)
 * renders "[object Object]". A folder dimension's value is an absolute path, so
 * name it by its last segment rather than 60 characters of /Users/…
 *
 * @param {Array<{dimension:string, value:unknown}>|null} path
 * @returns {string}
 */
export function groupLabel(path) {
  const last = (path || []).at(-1);
  if (!last) return "this group";
  const v = String(last.value ?? "");
  return v.split("/").filter(Boolean).pop() || v || "this group";
}
