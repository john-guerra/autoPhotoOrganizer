/**
 * The tree's right-click menu, as data.
 *
 * A pure builder, the same contract as stackActions.js: the LABELS and the
 * ENABLEMENT rules live here (where they can be unit-tested without a browser),
 * and App keeps only the handlers. ContextMenu.svelte renders the result — it is
 * the shared menu surface, and it is meant to be extended by passing more items,
 * not by growing a second menu component.
 *
 * The one rule that shapes this whole file: a VIRTUAL ancestor is a folder on
 * disk that has no row in the `folders` table, because the index only records
 * folders that contain photos. So it can be revealed, rescanned, jumped to,
 * selected and folded — all of which work over its subtree — but it can NOT be
 * renamed or removed, because there is nothing in the index to rename or remove.
 * Offering those anyway would be a menu item that silently does nothing.
 */

/**
 * @param {object} ctx
 * @param {Array<{dimension:string,value:string}>} ctx.path   the row's group path
 * @param {string|null} ctx.folderPath   its absolute path, or null if not a folder
 * @param {boolean} ctx.isVirtual        a photo-less ancestor (no `folders` row)
 * @param {boolean} ctx.isFolder         the row is a folder dimension at all
 * @param {boolean} ctx.hasChildren      it has sub-folders in the tree
 * @param {boolean} ctx.expanded         those sub-folders are showing
 * @param {string} ctx.rendererId        "grid" | "snapshot" | "collapsed"
 * @param {boolean} ctx.canJump          there is somewhere to jump to
 * @param {object} ctx.on                the handlers (App owns these)
 * @returns {Array<{label?:string, action?:()=>void, enabled?:boolean, danger?:boolean, separator?:boolean}>}
 */
export function buildTreeMenuItems({
  path,
  folderPath = null,
  isVirtual = false,
  isFolder = false,
  hasChildren = false,
  expanded = false,
  rendererId = "grid",
  canJump = true,
  on = {},
}) {
  const items = [];

  items.push({
    label: "Jump to this group",
    enabled: canJump,
    action: () => on.jump?.(),
  });

  // "Select every photo in here" means the whole subtree for a virtual ancestor —
  // it has no photos of its own, so its own path would select nothing.
  items.push({
    label: isVirtual
      ? "Select all photos in this subtree"
      : "Select all photos in this group",
    action: () => on.selectAll?.(),
  });
  items.push({
    label: "Keep only these photos",
    action: () => on.keepOnly?.(),
  });

  items.push({ separator: true });

  items.push({
    label: nextViewLabel(rendererId),
    action: () => on.cycleView?.(),
  });
  if (hasChildren) {
    items.push({
      label: expanded ? "Collapse all sub-folders" : "Expand all sub-folders",
      action: () => on.toggleDescendants?.(),
    });
  }

  if (isFolder) {
    items.push({ separator: true });
    items.push({
      label: "Reveal in Finder",
      enabled: !!folderPath,
      action: () => on.reveal?.(),
    });
    items.push({
      label: "Copy path",
      enabled: !!folderPath,
      action: () => on.copyPath?.(),
    });
    items.push({
      label: "Rescan this folder",
      enabled: !!folderPath,
      action: () => on.rescan?.(),
    });

    items.push({ separator: true });
    items.push({
      label: "Remove from library…",
      // A virtual ancestor has no `folders` row to remove. The trailing ellipsis
      // is a promise: this one asks before it does anything (ContextMenu closes
      // on every action, so the confirm has to outlive the menu — App opens a
      // Modal).
      enabled: !isVirtual,
      danger: true,
      action: () => on.remove?.(),
    });
  }

  return items;
}

/** What the view-cycle item will DO, not what state the group is in — a menu
 *  item is a verb. Mirrors groupRenderers' grid → snapshot → collapsed order. */
function nextViewLabel(rendererId) {
  if (rendererId === "grid") return "Show as a snapshot strip";
  if (rendererId === "snapshot") return "Collapse this group";
  return "Show all photos";
}
