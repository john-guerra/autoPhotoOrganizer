<script>
  import { createEventDispatcher } from "svelte";
  import { treeKey } from "./treeState.js";

  export let groupBy; // string[]
  export let path; // Array<{dimension,value}> — this node's own path
  export let node; // {value, label, count, hasChildren}
  export let expandedKeys; // Set<string>
  export let childrenByKey; // Map<string, {nodes, error?}>
  export let loadingKeys; // Set<string>
  export let highlightedKey; // string|null
  export let isCollapsedInFeed; // (path) => boolean

  const dispatch = createEventDispatcher();

  $: depth = path.length - 1;
  $: key = treeKey(path);
  $: expanded = expandedKeys.has(key);
  $: loading = loadingKeys.has(key);
  $: children = childrenByKey.get(key)?.nodes ?? [];
  $: childError = childrenByKey.get(key)?.error;
  $: collapsedInFeed = isCollapsedInFeed(path);
</script>

<li class="tree-node" class:highlighted={highlightedKey === key}>
  <div class="tree-node-row">
    {#if node.hasChildren}
      <button
        class="tree-fold-icon"
        title="Expand/collapse in tree (shift-click: fold all descendants)"
        on:click={(e) => dispatch("toggleExpand", { path, event: e })}
      >
        {expanded ? "▾" : "▸"}
      </button>
    {:else}
      <span class="tree-fold-spacer"></span>
    {/if}
    <button
      class="tree-collapse-icon"
      title={collapsedInFeed ? "Expand in feed" : "Collapse in feed"}
      on:click={(e) => dispatch("toggleCollapse", { path, event: e })}
    >
      {collapsedInFeed ? "▸" : "▾"}
    </button>
    <button class="tree-label" on:click={() => dispatch("jump", path)}>
      {node.label}
    </button>
    <span class="tree-count">{node.count}</span>
  </div>
  {#if expanded}
    <ul class="tree-level">
      {#if loading}
        <li class="tree-loading">Loading…</li>
      {:else if childError}
        <li class="tree-error">{childError}</li>
      {:else}
        {#each children as child (child.value)}
          <svelte:self
            {groupBy}
            path={[...path, { dimension: groupBy[depth + 1], value: child.value }]}
            node={child}
            {expandedKeys}
            {childrenByKey}
            {loadingKeys}
            {highlightedKey}
            {isCollapsedInFeed}
            on:toggleExpand
            on:toggleCollapse
            on:jump
          />
        {/each}
      {/if}
    </ul>
  {/if}
</li>

<style>
  .tree-node-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
  }
  .tree-fold-icon,
  .tree-collapse-icon {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    width: 16px;
    padding: 0;
  }
  .tree-fold-spacer {
    display: inline-block;
    width: 16px;
  }
  .tree-label {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-label:hover {
    text-decoration: underline;
  }
  .tree-count {
    color: #888;
    font-size: 0.85em;
  }
  .tree-node.highlighted > .tree-node-row {
    background: #2a2a2a;
    border-radius: 4px;
  }
  .tree-loading,
  .tree-error {
    color: #888;
    font-size: 0.85em;
    padding: 2px 0 2px 20px;
  }
  .tree-level {
    list-style: none;
    margin: 0;
    padding-left: 14px;
  }
</style>
