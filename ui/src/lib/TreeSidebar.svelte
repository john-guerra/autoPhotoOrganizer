<script>
  import { createEventDispatcher } from "svelte";
  import { fetchTreeNode } from "./api.js";
  import { treeKey, collapseDescendants } from "./treeState.js";
  import TreeNode from "./TreeNode.svelte";

  export let groupBy; // string[]
  export let collapsedPaths; // Array<Array<{dimension,value}>>
  export let snapshotKeys = new Set(); // pathKeys rendered as a snapshot strip
  export let filter = null;
  export let sort = null; // feed sort — date sorts change the date-group order
  export let refreshToken = 0; // bump to force a reload when the index changes

  const dispatch = createEventDispatcher();

  let rootTotal = null;
  let rootNodes = [];
  let childrenByKey = new Map(); // treeKey(path) -> { nodes, error? }
  let expandedKeys = new Set();
  let loadingKeys = new Set();
  let highlightedKey = null;

  async function loadRoot() {
    try {
      const { total, nodes } = await fetchTreeNode({
        groupBy,
        path: [],
        filter,
        sort,
      });
      rootTotal = total;
      rootNodes = nodes;
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
    // unfold one node at a time isn't much of a map. expandAll() is capped
    // (MAX_EXPAND_NODES) and reports when it stops, so a huge library degrades
    // to "expanded as far as is sane" rather than a fetch storm.
    if (groupBy.length > 1) expandAll();
  }
  $: (groupBy, filter, sort, refreshToken, resetAndLoad());

  async function loadChildren(path) {
    const key = treeKey(path);
    if (childrenByKey.has(key) || loadingKeys.has(key)) return;
    loadingKeys = new Set(loadingKeys).add(key);
    try {
      const { nodes } = await fetchTreeNode({ groupBy, path, filter, sort });
      childrenByKey = new Map(childrenByKey).set(key, { nodes });
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
  const MAX_EXPAND_NODES = 800;
  let expandingAll = false;
  let expandAllNote = "";

  async function expandAll() {
    if (expandingAll) return;
    expandingAll = true;
    expandAllNote = "";
    try {
      const next = new Set(expandedKeys);
      let frontier = rootNodes
        .filter((n) => n.hasChildren)
        .map((n) => ({
          path: [{ dimension: groupBy[0], value: n.value }],
          depth: 0,
        }));
      let visited = 0;
      let truncated = false;
      while (frontier.length && !truncated) {
        const nextFrontier = [];
        for (const { path, depth } of frontier) {
          if (++visited > MAX_EXPAND_NODES) {
            truncated = true;
            break;
          }
          next.add(treeKey(path));
          await loadChildren(path);
          const childDim = groupBy[depth + 1];
          if (!childDim) continue;
          for (const kid of childrenByKey.get(treeKey(path))?.nodes ?? []) {
            if (kid.hasChildren) {
              nextFrontier.push({
                path: [...path, { dimension: childDim, value: kid.value }],
                depth: depth + 1,
              });
            }
          }
        }
        frontier = nextFrontier;
      }
      expandedKeys = next;
      if (truncated) {
        expandAllNote = `Stopped at ${MAX_EXPAND_NODES} groups — expand deeper levels by hand.`;
      }
    } finally {
      expandingAll = false;
    }
  }

  function collapseAll() {
    expandedKeys = new Set();
    expandAllNote = "";
  }

  function handleToggleExpand({ detail: { path, event } }) {
    const key = treeKey(path);
    if (expandedKeys.has(key)) {
      expandedKeys = event.shiftKey
        ? collapseDescendants(expandedKeys, path)
        : deleteKey(expandedKeys, key);
    } else {
      expandedKeys = new Set(expandedKeys).add(key);
      loadChildren(path);
    }
  }

  function handleToggleCollapse({ detail: { path, event } }) {
    event.stopPropagation();
    // Forward the event too: App needs the shiftKey to decide "fold this group"
    // vs "fold all of its leaves" (VS Code-style folding).
    dispatch("toggle", { path, event });
  }

  function handleJump({ detail: path }) {
    dispatch("jump", path);
  }

  /** Walks `targetPath` from the root, fetching + expanding each level as
   * needed, then highlights the resulting node — called by App.svelte's
   * "reveal current location" button via bind:this. */
  export async function revealPath(targetPath) {
    let prefix = [];
    for (let i = 0; i < targetPath.length; i++) {
      const key = treeKey(prefix);
      if (!expandedKeys.has(key)) {
        expandedKeys = new Set(expandedKeys).add(key);
      }
      await loadChildren(prefix);
      prefix = [...prefix, targetPath[i]];
    }
    highlightedKey = treeKey(targetPath);
  }
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
      disabled={expandingAll || groupBy.length < 2}
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
