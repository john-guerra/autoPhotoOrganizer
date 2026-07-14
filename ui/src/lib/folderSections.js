/**
 * Turns the feed's FLAT folder headers into a nested folder hierarchy — the same
 * subtree the sidebar draws, rendered as sections in the feed.
 *
 * The feed only ever sees LEAF folders: an item carries `groupValues.folder =
 * "/L/Cards/Cam1"` and nothing else, so a photo-less ancestor like "/L/Cards"
 * appears in no item and must be invented. folderTree.js already invents exactly
 * those (and merges unary chains, and rolls up counts) for the sidebar, so this
 * reuses it rather than growing a second, drifting notion of the folder tree.
 *
 * THE KEY IDEA, borrowed from TreeSidebar.svelte: a folder at any tree depth
 * still occupies exactly ONE groupBy slot. So a header carries two different
 * depths, and conflating them is the bug this module exists to avoid:
 *
 *   - `path`        what the SERVER understands — always one {dimension:"folder"}
 *                   segment, whatever the nesting. Keys renderers, counts,
 *                   rename, remove, select-all.
 *   - `visualDepth` what the LAYOUT draws — indent, sticky offset, the dendrogram
 *                   trunk. Grows with the folder's depth in the tree.
 *
 * Ordering precondition: the server must hand items back in PRE-ORDER (a folder,
 * then its children, then its next sibling), or a subtree is not contiguous and
 * sections would re-open. That is what `folders.sort_path` buys — see the
 * invariant at the top of server/db/feed.js.
 */

import { chainTo, descendantGroups } from "./folderTree.js";
import { pathKey } from "./feed.js";

const FOLDER_DIMS = new Set(["folder", "folderName"]);

/** The trie keys folders by their split-and-rejoined path, so a stored path with
 *  a trailing slash never matches its own node. Exactly one folder in the real
 *  library has one ("…/2026_06Jun_22_Caos_SF_Fotos_Caos/"), and it rendered flat
 *  while every other folder nested. Normalise for the LOOKUP only — the raw value
 *  is what the server matches `abs_path` against, so the header it produces must
 *  keep it (see emitChain's leaf). */
function trieKey(value) {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

/**
 * @typedef {object} NestedHeader
 * @property {number} index        index into displayEntries (unchanged)
 * @property {number} depth        the groupBy index (unchanged — path/count logic)
 * @property {number} visualDepth  nesting level for indent/sticky/trunk
 * @property {string} dimension
 * @property {string} value
 * @property {string} label        the folder's OWN name (or merged "a/b/c" chain)
 * @property {Array<{dimension:string,value:string}>} path
 * @property {boolean} isVirtual   a photo-less ancestor invented by the trie
 * @property {Array<Array<{dimension:string,value:string}>>} groupPaths
 *           every real group at/below this row. A virtual row has no `folders`
 *           entry of its own, so select-all / keep-only / collapse act on these
 *           (the sidebar folds a virtual row the same way).
 * @property {number|undefined} count  rolled-up photo count, for folder rows
 */

/**
 * @param {Array<{index:number, depth:number, dimension:string, value:string, label:string, path:Array<{dimension:string,value:string}>}>} headers
 *        computeHeaderPaths(deriveSectionHeaders(...)) output, untouched.
 * @param {{groupBy: string[], rootsByParentKey: Map<string, import("./folderTree.js").FolderNode[]>}} ctx
 *        one folder trie per folder-dimension PREFIX (for groupBy ["year","folder"]
 *        the folders of 2024 and of 2023 are different tries), keyed by pathKey().
 * @returns {NestedHeader[]}
 */
export function nestFolderHeaders(headers, { groupBy, rootsByParentKey }) {
  const out = [];

  // The folder chain currently open, the groupBy index it sits at, and which
  // parent group it belongs to.
  /** @type {import("./folderTree.js").FolderNode[]} */
  let openChain = [];
  let openFolderDepth = -1;
  let openPrefixKey = null;

  for (const h of headers) {
    // A header STRICTLY above the open folder's groupBy level ends the section
    // that folder lived in. Grouping by ["year","folder"], the same folder under
    // a new year is a NEW section and must get its headers back — without this it
    // would be swallowed as "already open" and 2023's photos would sit under a
    // header that isn't there.
    //
    // Strictly above, not at-or-above: a SIBLING folder shares the folder's own
    // depth, and resetting there would throw away the shared ancestor chain and
    // re-emit it above every sibling — a fresh dendrogram trunk per child.
    if (h.depth < openFolderDepth) {
      openChain = [];
      openFolderDepth = -1;
      openPrefixKey = null;
    }

    if (!FOLDER_DIMS.has(h.dimension)) {
      // A dimension nested under an open folder must clear the whole folder
      // chain, not just its one groupBy slot.
      const extra = openChain.length ? openChain.length - 1 : 0;
      out.push({
        ...h,
        visualDepth: h.depth + extra,
        isVirtual: false,
        groupPaths: [h.path],
      });
      continue;
    }

    const prefix = h.path.slice(0, -1);
    const prefixKey = pathKey(prefix);
    const roots = rootsByParentKey.get(prefixKey) ?? [];
    const chain = chainTo(roots, trieKey(h.value));

    if (!chain.length) {
      // The trie is fetched async; until it lands (or if the folder is missing
      // from it) render the flat header we already have. Never a blank feed.
      openChain = [];
      openFolderDepth = -1;
      openPrefixKey = null;
      out.push({
        ...h,
        visualDepth: h.depth,
        isVirtual: false,
        groupPaths: [h.path],
      });
      continue;
    }

    // A folder under a DIFFERENT parent group is a different tree, even at the
    // same depth — nothing of the previous chain is open above it.
    const stillOpen = prefixKey === openPrefixKey ? openChain : [];
    out.push(...emitChain(chain, stillOpen, h, prefix));
    openChain = chain;
    openFolderDepth = h.depth;
    openPrefixKey = prefixKey;
  }

  return out;
}

/** One header per folder-tree row that is NEWLY opened by this group — the rows
 *  already open above it (shared with the previous folder) must not repeat.
 *  @param {import("./folderTree.js").FolderNode[]} chain  root..leaf for this folder
 *  @param {import("./folderTree.js").FolderNode[]} openChain  what is already open
 *  @param {object} h  the flat header being expanded
 *  @param {Array<{dimension:string,value:string}>} prefix  groupBy levels above the folder
 *  @returns {NestedHeader[]} */
function emitChain(chain, openChain, h, prefix) {
  // Compared by VALUE, not by node identity: rootsByParentKey is a reactive
  // derivation that rebuilds every time a count fetch lands, so the node objects
  // are new each render even when the tree is unchanged. Identity would re-emit
  // every ancestor on each rebuild — a fresh trunk per sibling, flickering.
  let shared = 0;
  while (
    shared < chain.length &&
    shared < openChain.length &&
    chain[shared].value === openChain[shared].value
  ) {
    shared += 1;
  }

  return chain.slice(shared).map((node, i) => {
    // The LEAF is this header's own group, so it keeps the value the server gave
    // us verbatim — the trie's copy has been normalised (see trieKey) and would
    // no longer match `abs_path`, silently breaking select/collapse/remove on the
    // one folder in the library whose path carries a trailing slash.
    const isLeaf = shared + i === chain.length - 1;
    const value = isLeaf ? h.value : node.value;
    return {
      ...h,
      nested: true, // label is this row's OWN name — App renders it differently
      value,
      // The row's OWN name (or the merged "a/b/c" chain), not the full path — the
      // nesting is what now says where it sits. App runs this through labelParts,
      // so the same folder reads identically in the feed and in the tree.
      label: node.label,
      visualDepth: h.depth + shared + i,
      // One folder slot, whatever the visual depth — this is what the server
      // understands (see TreeSidebar's childRows, the precedent).
      path: [...prefix, { dimension: h.dimension, value }],
      // A virtual ancestor has no `folders` row, so nothing can select, rename or
      // remove it by equality; actions on it act over its subtree instead.
      isVirtual: !node.isGroup,
      groupPaths: descendantGroups(node).map((v) => [
        ...prefix,
        { dimension: h.dimension, value: v },
      ]),
      // Rolled up (ownCount + descendants), the same number the sidebar shows for
      // this folder — one folder must never show two different counts.
      count: node.count,
    };
  });
}
