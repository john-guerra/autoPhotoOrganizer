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
 * folders that contain photos. Everything the menu offers works over its subtree
 * — reveal, rescan, jump, select, fold, and (since the remove endpoint became a
 * subtree operation) REMOVE, which drops every descendant folder + their photos
 * by path prefix. It still can't be RENAMED (that repoints a single row that
 * doesn't exist), but "nothing to remove" is no longer true: removing a
 * photo-less ancestor removes everything under it.
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
      // A virtual ancestor owns no photos directly, so removing it is inherently
      // "and everything inside it"; a real folder with sub-folders reads the same
      // way. The removal is a subtree operation either way (see
      // deleteFolderSubtree), so the label says so.
      label: isVirtual
        ? "Remove folder and its contents…"
        : hasChildren
          ? "Remove folder and its contents…"
          : "Remove from library…",
      // Always enabled for a folder row: the trailing ellipsis is a promise that
      // it asks first (ContextMenu closes on every action, so the confirm has to
      // outlive the menu — App opens a Modal). It used to be disabled on a virtual
      // ancestor ("nothing to remove"), but the remove endpoint now takes the
      // whole subtree, so a photo-less parent removes every descendant under it.
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
