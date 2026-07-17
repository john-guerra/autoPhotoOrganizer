/**
 * Pure keyboard-navigation math for the Library tree. No DOM, no Svelte — the
 * caller supplies the ordered list of currently-visible rows (read from the
 * rendered tree) and the cursor's index; these compute where the cursor goes.
 * See docs/superpowers/specs/2026-07-17-tree-keyboard-nav-design.md.
 */

/** A valid, stable DOM id for a tree row from its treeKey — the same on the row
 * (TreeNode) and in the container's aria-activedescendant (TreeSidebar), so a
 * folder name with spaces/slashes can't produce an invalid or mismatched id. */
export const rowDomId = (key) => "tk-" + encodeURIComponent(String(key));

/** Clamp `i` into [0, len-1]; -1 for an empty list. */
function clampIndex(len, i) {
  if (len <= 0) return -1;
  return Math.max(0, Math.min(len - 1, i));
}

/**
 * New cursor index after an arrow/home/end/page action, clamped to the list.
 * @param {number} rowCount   number of visible rows
 * @param {number} index      current cursor index (may be -1 when unset)
 * @param {"up"|"down"|"home"|"end"|"pageup"|"pagedown"} action
 * @param {number} [pageSize] rows per Page{Up,Down} (default 10)
 * @returns {number} the target index, or -1 for an empty list
 */
export function moveCursor(rowCount, index, action, pageSize = 10) {
  if (rowCount <= 0) return -1;
  const cur = index < 0 ? 0 : index; // an unset cursor starts at the top
  switch (action) {
    case "up":
      return clampIndex(rowCount, cur - 1);
    case "down":
      return clampIndex(rowCount, cur + 1);
    case "home":
      return 0;
    case "end":
      return rowCount - 1;
    case "pageup":
      return clampIndex(rowCount, cur - Math.max(1, pageSize));
    case "pagedown":
      return clampIndex(rowCount, cur + Math.max(1, pageSize));
    default:
      return cur;
  }
}

/**
 * Index of the next row whose label CONTAINS `buffer` (case-insensitive),
 * searching cyclically from AFTER the cursor so repeated keystrokes step through
 * matches, then wrapping back through the cursor itself. -1 when nothing matches
 * or the buffer is empty.
 *
 * Substring, not prefix: this library's folders are commonly date-stamped
 * ("2024_03Mar_05 Cards"), so a startsWith match would force the user to type the
 * date. "Cards" / "Trip" / "Hawaii" — the part they think in — should just work.
 *
 * @param {string[]} labels
 * @param {number} fromIndex  current cursor index
 * @param {string} buffer     the accumulated type-ahead string
 * @returns {number}
 */
export function typeAheadTarget(labels, fromIndex, buffer) {
  const q = String(buffer ?? "").toLowerCase();
  if (!q || !labels.length) return -1;
  const start = fromIndex < 0 ? 0 : fromIndex;
  for (let step = 1; step <= labels.length; step++) {
    const i = (start + step) % labels.length;
    if (
      String(labels[i] ?? "")
        .toLowerCase()
        .includes(q)
    )
      return i;
  }
  return -1;
}
