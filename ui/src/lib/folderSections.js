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
 *
 * AGGREGATE subtrees (#142): a parent folder can also be in an "aggregate"
 * state — its whole subtree folded as one unit (a snapshot strip sampling
 * every descendant, or one collapsed bar with the subtree total), rather than
 * nested. That state is identified the same way a collapsed LEAF group is —
 * by its own path — except the last segment carries `subtree: true`
 * (docs/superpowers/plans/2026-07-24-subtree-fold-and-snapshot.md's data
 * model), and it is threaded through THIS module (not just read at render
 * time the way `collapsedKeys`/`snapshotKeys` are in App.svelte's
 * `rendererIdFor`) because only the trie walk here knows which headers are
 * that parent's DESCENDANTS and must be suppressed along with it. A leaf
 * collapse never has descendants to hide — it IS the leaf — so it never
 * needed this; a subtree collapse does.
 */

import { chainTo, descendantGroups } from "./folderTree.js";
import { pathKey } from "./feed.js";

/** Renderer ids for an aggregated parent — the subtree equivalents of
 *  groupRenderers.js's "snapshot"/"collapsed", but never registered there:
 *  a plain leaf's renderer is decided per-header at render time
 *  (`rendererIdFor`), while an aggregate parent's is decided HERE, because it
 *  is this module that knows the header is a whole-subtree stand-in rather
 *  than one real group. Exported so later work (the SnapshotStrip/App.svelte
 *  wiring, task 6/7 of the #142 plan) can key off them by name. */
export const AGGREGATE_SNAPSHOT_RENDERER_ID = "aggregate-snapshot";
export const AGGREGATE_COLLAPSED_RENDERER_ID = "aggregate-collapsed";

/**
 * Only `folder` nests. NOT `folderName`.
 *
 * The two carry the same value server-side (the absolute path — that is the
 * group's identity, and it is what makes Remove and Reveal work for both), and
 * they differ only in how it is DISPLAYED: `folder` shows the path, `folderName`
 * shows the basename. That made it tempting to nest both, since the trie is built
 * from the value and the value is a path either way.
 *
 * But a hierarchy of names isn't even well-defined: grouping by NAME says two
 * folders called "Selects" under different parents are the same kind of thing, so
 * there is no parent to hang them under. The sidebar has always known this — it
 * builds the trie only for `folder` (TreeSidebar's `childRows`) — and the feed
 * nesting `folderName` while the tree listed it flat meant the two navigators
 * disagreed about the shape of the same library.
 */
const FOLDER_DIMS = new Set(["folder"]);

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
 * @param {{groupBy: string[], rootsByParentKey: Map<string, import("./folderTree.js").FolderNode[]>, aggregateKeys?: Set<string>, aggregateSnapshotKeys?: Set<string>}} ctx
 *        one folder trie per folder-dimension PREFIX (for groupBy ["year","folder"]
 *        the folders of 2024 and of 2023 are different tries), keyed by pathKey().
 *        `aggregateKeys` is every parent currently folded as one subtree
 *        (pathKey of `[...prefix, {dimension:"folder", value, subtree:true}]`);
 *        `aggregateSnapshotKeys` is the subset of those that show a snapshot
 *        strip rather than a collapsed bar — mirrors how App.svelte's
 *        `collapsedKeys`/`snapshotKeys` pair works for a plain leaf group.
 *        Both default to empty, so an existing caller that never passes them
 *        gets today's behaviour unchanged.
 * @returns {NestedHeader[]}
 */
export function nestFolderHeaders(
  headers,
  {
    groupBy,
    rootsByParentKey,
    aggregateKeys = new Set(),
    aggregateSnapshotKeys = new Set(),
  }
) {
  const out = [];

  // The folder chain currently open, the groupBy index it sits at, and which
  // parent group it belongs to.
  /** @type {import("./folderTree.js").FolderNode[]} */
  let openChain = [];
  let openFolderDepth = -1;
  let openPrefixKey = null;
  // Index within openChain of an ancestor already emitted as ONE aggregate
  // header, or -1 if nothing aggregated is currently open. Every header
  // at-or-below that index, for as long as the same chain stays open, is
  // fully suppressed: no header of its own, nested dimension or not.
  let openAggregateIndex = -1;

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
      openAggregateIndex = -1;
    }

    if (!FOLDER_DIMS.has(h.dimension)) {
      // Nested beneath an aggregated parent — that parent's one header already
      // stands for this whole dimension too.
      if (openAggregateIndex !== -1) continue;
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
      openAggregateIndex = -1;
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
    const shared = sharedPrefixLength(chain, stillOpen);

    if (openAggregateIndex !== -1 && shared > openAggregateIndex) {
      // This header's own chain shares everything up to and including the
      // already-open aggregate ancestor — it is one of that parent's
      // descendants (e.g. Cam10 once Cam1 already folded Cards into one
      // header). It stays swallowed; the open state doesn't change.
      openChain = chain;
      openFolderDepth = h.depth;
      openPrefixKey = prefixKey;
      continue;
    }

    const { headers: emitted, aggregateIndex } = emitChain(
      chain,
      shared,
      h,
      prefix,
      { aggregateKeys, aggregateSnapshotKeys }
    );
    out.push(...emitted);
    openChain = chain;
    openFolderDepth = h.depth;
    openPrefixKey = prefixKey;
    openAggregateIndex = aggregateIndex;
  }

  return out;
}

/** How much of `chain`'s prefix is already open (shared with `openChain`).
 *  Compared by VALUE, not node identity — see emitChain's own note: the trie
 *  rebuilds on every render, so objects are never the same instance twice. */
function sharedPrefixLength(chain, openChain) {
  let shared = 0;
  while (
    shared < chain.length &&
    shared < openChain.length &&
    chain[shared].value === openChain[shared].value
  ) {
    shared += 1;
  }
  return shared;
}

/** One header per folder-tree row that is NEWLY opened by this group — the rows
 *  already open above it (shared with the previous folder) must not repeat.
 *  Stops EARLY, without descending further, at the first node whose own
 *  subtree is in `aggregateKeys` (#142) — that node gets a single aggregate
 *  header in place of itself and everything beneath it in this chain.
 *  @param {import("./folderTree.js").FolderNode[]} chain  root..leaf for this folder
 *  @param {number} shared  how much of the chain's prefix is already open (see
 *         sharedPrefixLength) — only chain[shared..] is newly opened here
 *  @param {object} h  the flat header being expanded
 *  @param {Array<{dimension:string,value:string}>} prefix  groupBy levels above the folder
 *  @param {{aggregateKeys: Set<string>, aggregateSnapshotKeys: Set<string>}} aggregate
 *  @returns {{headers: NestedHeader[], aggregateIndex: number}} aggregateIndex
 *           is the chain index newly folded into one header, or -1 if none. */
function emitChain(
  chain,
  shared,
  h,
  prefix,
  { aggregateKeys, aggregateSnapshotKeys }
) {
  const headers = [];
  let aggregateIndex = -1;

  for (let i = shared; i < chain.length; i += 1) {
    const node = chain[i];
    // The LEAF is this header's own group, so it keeps the value the server gave
    // us verbatim — the trie's copy has been normalised (see trieKey) and would
    // no longer match `abs_path`, silently breaking select/collapse/remove on the
    // one folder in the library whose path carries a trailing slash.
    const isLeaf = i === chain.length - 1;
    const value = isLeaf ? h.value : node.value;
    // One folder slot, whatever the visual depth — this is what the server
    // understands (see TreeSidebar's childRows, the precedent). Checked against
    // aggregateKeys BEFORE subtree:true is added, since pathKey only encodes
    // dimension+value — the flag never changes the key, only what downstream
    // readers of the emitted header see.
    const path = [...prefix, { dimension: h.dimension, value }];
    const key = pathKey(path);
    const isAggregate = aggregateKeys.has(key);

    headers.push({
      ...h,
      nested: true, // label is this row's OWN name — App renders it differently
      value,
      // The row's OWN name (or the merged "a/b/c" chain), not the full path — the
      // nesting is what now says where it sits. App runs this through labelParts,
      // so the same folder reads identically in the feed and in the tree.
      label: node.label,
      visualDepth: h.depth + i,
      path: isAggregate
        ? [...prefix, { dimension: h.dimension, value, subtree: true }]
        : path,
      // A virtual ancestor has no `folders` row, so nothing can select, rename or
      // remove it by equality; actions on it act over its subtree instead.
      isVirtual: !node.isGroup,
      groupPaths: descendantGroups(node).map((v) => [
        ...prefix,
        { dimension: h.dimension, value: v },
      ]),
      // Rolled up (ownCount + descendants), the same number the sidebar shows for
      // this folder — one folder must never show two different counts. For an
      // aggregate row this IS the bar's/strip's total.
      count: node.count,
      ...(isAggregate
        ? {
            rendererId: aggregateSnapshotKeys.has(key)
              ? AGGREGATE_SNAPSHOT_RENDERER_ID
              : AGGREGATE_COLLAPSED_RENDERER_ID,
          }
        : {}),
    });

    if (isAggregate) {
      aggregateIndex = i;
      break; // never descend into this node's children — they're folded into it
    }
  }

  return { headers, aggregateIndex };
}
