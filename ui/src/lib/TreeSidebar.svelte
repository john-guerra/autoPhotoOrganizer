<script>
  import { createEventDispatcher } from "svelte";
  import { fetchTreeNode } from "./api.js";
  import { treeKey, collapseDescendants } from "./treeState.js";
  import TreeNode from "./TreeNode.svelte";

  export let groupBy; // string[]
  export let collapsedPaths; // Array<Array<{dimension,value}>>
  export let filter = null;

  const dispatch = createEventDispatcher();

  let rootTotal = null;
  let rootNodes = [];
  let childrenByKey = new Map(); // treeKey(path) -> { nodes, error? }
  let expandedKeys = new Set();
  let loadingKeys = new Set();
  let highlightedKey = null;

  async function loadRoot() {
    try {
      const { total, nodes } = await fetchTreeNode({ groupBy, path: [], filter });
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
  function resetAndLoad() {
    childrenByKey = new Map();
    expandedKeys = new Set();
    loadingKeys = new Set();
    highlightedKey = null;
    loadRoot();
  }
  $: groupBy, filter, resetAndLoad();

  async function loadChildren(path) {
    const key = treeKey(path);
    if (childrenByKey.has(key) || loadingKeys.has(key)) return;
    loadingKeys = new Set(loadingKeys).add(key);
    try {
      const { nodes } = await fetchTreeNode({ groupBy, path, filter });
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
    dispatch("toggle", path);
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
        on:toggleExpand={handleToggleExpand}
        on:toggleCollapse={handleToggleCollapse}
        on:jump={handleJump}
      />
    {/each}
  </ul>
</nav>

<style>
  .tree-sidebar {
    width: 260px;
    flex: 0 0 260px;
    overflow-y: auto;
    border-right: 1px solid #2a2a2a;
    padding: 8px;
    box-sizing: border-box;
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
