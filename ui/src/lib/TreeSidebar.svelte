<script>
  import { createEventDispatcher } from "svelte";
  import { fetchTreeNode } from "./api.js";
  import { treeKey, collapseDescendants } from "./treeState.js";
  import { buildFolderTree, isFolderNode, chainTo } from "./folderTree.js";
  import { EMPTY_STATS } from "./folderLabel.js";
  import TreeNode from "./TreeNode.svelte";

  export let groupBy; // string[]
  export let collapsedPaths; // Array<Array<{dimension,value}>>
  export let snapshotKeys = new Set(); // pathKeys rendered as a snapshot strip
  export let filter = null;
  export let sort = null; // feed sort — date sorts change the date-group order
  export let refreshToken = 0; // bump to force a reload when the index changes
  // Library-wide token frequencies, for the folder label rule (folderLabel.js).
  // Owned by App (which already has the library list) so the feed's headers and
  // these rows judge a folder name by exactly the same corpus.
  export let tokenStats = EMPTY_STATS;

  const dispatch = createEventDispatcher();

  let rootTotal = null;
  let rootNodes = [];
  let childrenByKey = new Map(); // treeKey(path) -> { nodes, error? }
  let expandedKeys = new Set();
  let loadingKeys = new Set();
  let highlightedKey = null;

  /** Folder values nest; every other dimension's values are flat. The server can
   * only hand us the flat list (folders is a flat table — the hierarchy lives in
   * the path strings), so we build the tree here, once per level. */
  function shapeLevel(nodes, depth) {
    return groupBy[depth] === "folder" ? buildFolderTree(nodes) : nodes;
  }

  async function loadRoot() {
    try {
      const { total, nodes } = await fetchTreeNode({
        groupBy,
        path: [],
        filter,
        sort,
      });
      rootTotal = total;
      rootNodes = shapeLevel(nodes, 0);
    } catch {
      rootTotal = null;
      rootNodes = [];
    }
  }

  // A path is only meaningful under the groupBy order it was fetched
  // with, so the whole tree resets whenever the hierarchy order changes —
  // matches the same reasoning collapsedPaths already resets on hierarchy
  // change in App.svelte.
  async function resetAndLoad() {
    childrenByKey = new Map();
    expandedKeys = new Set();
    loadingKeys = new Set();
    highlightedKey = null;
    await loadRoot();
    // Open by default: the tree is a map of the library, and a map you have to
    // unfold one node at a time isn't much of a map. expandAll() is capped and
    // reports when it stops, so a huge library degrades to "expanded as far as is
    // sane" rather than a fetch storm.
    //
    // Grouping by folder ALONE is now a hierarchy too (folderTree.js), so the
    // old `groupBy.length > 1` test would have left the commonest grouping of all
    // starting collapsed — and folder levels cost no fetch to expand.
    if (groupBy.length > 1 || groupBy.includes("folder")) expandAll();
  }
  $: (groupBy, filter, sort, refreshToken, resetAndLoad());

  // Track the in-flight PROMISE, not just a "loading" flag: expandAll awaits
  // loadChildren and then reads childrenByKey, so bailing out early on a
  // concurrent fetch made it silently see an empty child list and stop
  // descending that subtree.
  const inflight = new Map(); // treeKey -> Promise

  async function loadChildren(path) {
    const key = treeKey(path);
    if (childrenByKey.has(key)) return;
    if (inflight.has(key)) return inflight.get(key);
    const p = loadChildrenNow(path, key);
    inflight.set(key, p);
    try {
      await p;
    } finally {
      inflight.delete(key);
    }
  }

  async function loadChildrenNow(path, key) {
    loadingKeys = new Set(loadingKeys).add(key);
    try {
      const { nodes } = await fetchTreeNode({ groupBy, path, filter, sort });
      childrenByKey = new Map(childrenByKey).set(key, {
        nodes: shapeLevel(nodes, path.length),
      });
    } catch (e) {
      childrenByKey = new Map(childrenByKey).set(key, {
        nodes: [],
        error: e.message,
      });
    } finally {
      const next = new Set(loadingKeys);
      next.delete(key);
      loadingKeys = next;
    }
  }

  function deleteKey(set, key) {
    const next = new Set(set);
    next.delete(key);
    return next;
  }

  // --- Expand all / collapse all -------------------------------------------
  // Expanding walks the hierarchy level by level, fetching each level's children
  // as it goes. A deep tree over a big library can be enormous, so it's capped:
  // we stop and SAY SO rather than firing thousands of requests.
  //
  // The cap that matters is the number of REQUESTS, not the number of rows. A
  // folder row's sub-folders arrived with its level's response, so expanding the
  // folder hierarchy is free — counting those against the request budget stopped a
  // 1,200-folder library less than a third of the way through and left most of the
  // tree folded, for no reason. Rows still get a (much looser) ceiling of their
  // own, since every row is DOM.
  const MAX_EXPAND_FETCHES = 800;
  const MAX_EXPAND_ROWS = 5000;
  let expandingAll = false;
  let expandAllNote = "";

  /** Does opening this row hit the server? Only a next-dimension level does — and
   * only for a folder that has photos of its own to group. */
  function needsFetch({ node, depth }) {
    if (!groupBy[depth + 1]) return false;
    return isFolderNode(node)
      ? Boolean(node.isGroup)
      : Boolean(node.hasChildren);
  }

  /** The rows beneath one row, whichever kind it is. A folder row's sub-folders
   * are already in hand (they came with this level's response, via the trie), so
   * only the next GROUPING dimension ever costs a fetch — and only a folder that
   * has photos of its own has one. */
  async function childRows({ node, path, depth }) {
    const rows = [];
    if (isFolderNode(node)) {
      for (const child of node.children) {
        rows.push({
          node: child,
          // Sub-folder rows keep this row's path length: the feed has ONE folder
          // dimension, however deep the folder sits.
          path: [
            ...path.slice(0, -1),
            { dimension: "folder", value: child.value },
          ],
          depth,
        });
      }
      if (!(node.isGroup && groupBy[depth + 1])) return rows;
    } else if (!node.hasChildren) {
      return rows;
    }
    const childDim = groupBy[depth + 1];
    if (!childDim) return rows;
    await loadChildren(path);
    for (const kid of childrenByKey.get(treeKey(path))?.nodes ?? []) {
      rows.push({
        node: kid,
        path: [...path, { dimension: childDim, value: kid.value }],
        depth: depth + 1,
      });
    }
    return rows;
  }

  async function expandAll() {
    if (expandingAll) return;
    expandingAll = true;
    expandAllNote = "";
    try {
      const next = new Set(expandedKeys);
      let frontier = rootNodes.map((node) => ({
        node,
        path: [{ dimension: groupBy[0], value: node.value }],
        depth: 0,
      }));
      let fetches = 0;
      let rows = frontier.length;
      let truncated = "";
      while (frontier.length && !truncated) {
        const nextFrontier = [];
        for (const row of frontier) {
          // Only a next-dimension level costs a request; a folder's sub-folders
          // are already here.
          if (needsFetch(row)) {
            if (++fetches > MAX_EXPAND_FETCHES) {
              truncated = `Stopped after ${MAX_EXPAND_FETCHES} groups — expand deeper levels by hand.`;
              break;
            }
          }
          const kids = await childRows(row);
          if (!kids.length) continue;
          next.add(treeKey(row.path));
          rows += kids.length;
          if (rows > MAX_EXPAND_ROWS) {
            truncated = `Stopped at ${MAX_EXPAND_ROWS} rows — expand deeper levels by hand.`;
            break;
          }
          nextFrontier.push(...kids);
        }
        frontier = nextFrontier;
      }
      expandedKeys = next;
      expandAllNote = truncated;
    } finally {
      expandingAll = false;
    }
  }

  function collapseAll() {
    expandedKeys = new Set();
    expandAllNote = "";
  }

  function handleToggleExpand({ detail: { path, event, fetch } }) {
    const key = treeKey(path);
    if (expandedKeys.has(key)) {
      expandedKeys = event.shiftKey
        ? collapseDescendants(expandedKeys, path)
        : deleteKey(expandedKeys, key);
    } else {
      expandedKeys = new Set(expandedKeys).add(key);
      // Sub-folders came with this level's response — only a deeper GROUPING
      // dimension costs a request. Fetching for a folder row that has none would
      // ask the server to group by nothing.
      if (fetch) loadChildren(path);
    }
  }

  function handleToggleCollapse({ detail: { path, event, paths } }) {
    event.stopPropagation();
    // Forward the event too: App needs the shiftKey to decide "fold this group"
    // vs "fold all of its leaves" (VS Code-style folding). `paths` is set when the
    // row stands for several groups at once (a virtual folder ancestor, or a
    // shift-click on a folder that has sub-folders) — App applies the cycle to all
    // of them together.
    dispatch("toggle", { path, event, paths });
  }

  function handleJump({ detail: path }) {
    dispatch("jump", path);
  }

  /** Walks `targetPath` from the root, fetching + expanding each level as
   * needed, then highlights the resulting node — called by App.svelte's
   * "reveal current location" button via bind:this. */
  export async function revealPath(targetPath) {
    let prefix = [];
    for (const seg of targetPath) {
      if (prefix.length) {
        expandedKeys = new Set(expandedKeys).add(treeKey(prefix));
        await loadChildren(prefix);
      }
      // A folder sits at some depth inside the trie, and compaction means its
      // ancestors' rows can't be derived from the path string (the row for
      // /a/b/c may be labelled "a/b/c"). Walk the built tree to find the rows
      // above it and open each one, or the target stays hidden.
      if (seg.dimension === "folder") {
        const levelNodes = prefix.length
          ? (childrenByKey.get(treeKey(prefix))?.nodes ?? [])
          : rootNodes;
        const next = new Set(expandedKeys);
        for (const node of chainTo(levelNodes, seg.value).slice(0, -1)) {
          next.add(
            treeKey([...prefix, { dimension: "folder", value: node.value }])
          );
        }
        expandedKeys = next;
      }
      prefix = [...prefix, seg];
    }
    highlightedKey = treeKey(targetPath);
  }

  // A folder grouping is a hierarchy even on its own, so "Expand all" is useful
  // with a single folder dimension — it wasn't when every level was flat.
  $: canExpandAll = groupBy.length > 1 || groupBy.includes("folder");

  // What a row's siblings are called is what tells us which of its tokens are
  // redundant (see folderLabel.js) — so every level passes its own labels down.
  $: rootLabels = rootNodes.map((n) => n.label);
</script>

<nav class="tree-sidebar" aria-label="Library hierarchy">
  <div class="tree-root">
    <span class="tree-root-label">Library</span>
    <span class="tree-root-count">{rootTotal ?? "…"}</span>
  </div>
  <div class="tree-actions">
    <button
      class="tree-action"
      title="Expand every group in the tree"
      disabled={expandingAll || !canExpandAll}
      on:click={expandAll}
    >
      {expandingAll ? "Expanding…" : "Expand all"}
    </button>
    <button
      class="tree-action"
      title="Collapse every group in the tree"
      disabled={expandingAll || expandedKeys.size === 0}
      on:click={collapseAll}
    >
      Collapse all
    </button>
  </div>
  {#if expandAllNote}
    <p class="tree-note" role="status">{expandAllNote}</p>
  {/if}
  <ul class="tree-level">
    {#each rootNodes as node (node.value)}
      <TreeNode
        {groupBy}
        path={[{ dimension: groupBy[0], value: node.value }]}
        {node}
        {expandedKeys}
        {childrenByKey}
        {loadingKeys}
        {highlightedKey}
        {collapsedPaths}
        {snapshotKeys}
        {tokenStats}
        siblingLabels={rootLabels}
        on:toggleExpand={handleToggleExpand}
        on:toggleCollapse={handleToggleCollapse}
        on:jump={handleJump}
      />
    {/each}
  </ul>
</nav>

<style>
  /* Fills the resizable sidebar pane owned by App.svelte (which sets the width
     and hosts the drag handle), rather than hard-coding its own width. */
  .tree-sidebar {
    width: 100%;
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 8px;
    box-sizing: border-box;
  }
  .tree-actions {
    display: flex;
    gap: 6px;
    padding: 4px 0 6px;
  }
  .tree-action {
    flex: 1;
    background: #1a1a1a;
    border: 1px solid #333;
    color: #cfcfcf;
    border-radius: 5px;
    padding: 3px 6px;
    font-size: 0.72rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .tree-action:hover:not(:disabled) {
    background: #262626;
  }
  .tree-action:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .tree-note {
    margin: 0 0 6px;
    font-size: 0.72rem;
    color: #ffd24c;
  }
  .tree-root {
    display: flex;
    justify-content: space-between;
    font-weight: 700;
    padding: 4px 0 8px;
    border-bottom: 1px solid #2a2a2a;
    margin-bottom: 4px;
  }
  .tree-level {
    list-style: none;
    margin: 0;
    padding-left: 14px;
  }
</style>
