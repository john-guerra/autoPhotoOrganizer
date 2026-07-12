<script>
  import { createEventDispatcher } from "svelte";
  import { treeKey } from "./treeState.js";
  import { shortLeafLabel } from "./labels.js";

  export let groupBy; // string[]
  export let path; // Array<{dimension,value}> — this node's own path
  export let node; // {value, label, count, hasChildren}
  export let expandedKeys; // Set<string>
  export let childrenByKey; // Map<string, {nodes, error?}>
  export let loadingKeys; // Set<string>
  export let highlightedKey; // string|null
  export let collapsedPaths; // Array<Array<{dimension,value}>>

  const dispatch = createEventDispatcher();

  $: depth = path.length - 1;
  $: key = treeKey(path);
  $: expanded = expandedKeys.has(key);
  $: loading = loadingKeys.has(key);
  $: children = childrenByKey.get(key)?.nodes ?? [];
  $: childError = childrenByKey.get(key)?.error;
  // Compare against collapsedPaths directly (not via a called function) so
  // Svelte's dependency tracking — based on the reactive statement's own
  // source text, not what a called function closes over — actually re-runs
  // this when collapsedPaths changes.
  $: collapsedInFeed = collapsedPaths.some((p) => treeKey(p) === key);

  /** Svelte action: when a truncated label is hovered, slide it left so the
   * whole name can be read, then slide back. Measures the real overflow (CSS
   * alone can't know it) and only animates when there IS overflow. */
  function hoverScroll(node) {
    let leaving;
    const distance = () =>
      Math.max(0, node.scrollWidth - node.parentElement.clientWidth);
    function enter() {
      clearTimeout(leaving);
      const d = distance();
      if (d <= 0) return;
      // Pace the slide by how much is hidden, so long names aren't glacial.
      node.style.transition = `transform ${Math.max(0.6, d / 40)}s linear`;
      node.style.transform = `translateX(${-d}px)`;
    }
    function leave() {
      node.style.transition = "transform 0.2s ease-out";
      node.style.transform = "translateX(0)";
      leaving = setTimeout(() => (node.style.transition = ""), 200);
    }
    node.parentElement.addEventListener("mouseenter", enter);
    node.parentElement.addEventListener("mouseleave", leave);
    return {
      destroy() {
        clearTimeout(leaving);
        node.parentElement?.removeEventListener("mouseenter", enter);
        node.parentElement?.removeEventListener("mouseleave", leave);
      },
    };
  }
</script>

<li class="tree-node" class:highlighted={highlightedKey === key}>
  <div class="tree-node-row">
    <!-- TREE structure: a disclosure triangle — shows/hides this node's CHILD
         folders here in the sidebar. -->
    {#if node.hasChildren}
      <button
        class="tree-fold-icon"
        title="Show/hide sub-folders in this tree (shift-click: fold all descendants)"
        aria-label="Show or hide sub-folders in the tree"
        aria-expanded={expanded}
        on:click={(e) => dispatch("toggleExpand", { path, event: e })}
      >
        {expanded ? "▾" : "▸"}
      </button>
    {:else}
      <span class="tree-fold-spacer"></span>
    {/if}
    <!-- FEED visibility: a photo-grid glyph — deliberately NOT a triangle, so
         it can't be mistaken for the tree's disclosure control above. Filled
         grid = this group's photos show in the feed; single bar = collapsed. -->
    <button
      class="tree-collapse-icon"
      class:collapsed={collapsedInFeed}
      title={collapsedInFeed
        ? "Photos hidden in the feed — click to show this group"
        : "Photos showing in the feed — click to collapse this group"}
      aria-label={collapsedInFeed
        ? "Show group in feed"
        : "Collapse group in feed"}
      aria-pressed={collapsedInFeed}
      on:click={(e) => dispatch("toggleCollapse", { path, event: e })}
    >
      {#if collapsedInFeed}
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <rect
            x="1"
            y="5"
            width="10"
            height="2.4"
            rx="0.6"
            fill="currentColor"
          />
        </svg>
      {:else}
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <rect
            x="1"
            y="1"
            width="4.4"
            height="4.4"
            rx="0.6"
            fill="currentColor"
          />
          <rect
            x="6.6"
            y="1"
            width="4.4"
            height="4.4"
            rx="0.6"
            fill="currentColor"
          />
          <rect
            x="1"
            y="6.6"
            width="4.4"
            height="4.4"
            rx="0.6"
            fill="currentColor"
          />
          <rect
            x="6.6"
            y="6.6"
            width="4.4"
            height="4.4"
            rx="0.6"
            fill="currentColor"
          />
        </svg>
      {/if}
    </button>
    <button
      class="tree-label"
      title={node.label}
      on:click={() => dispatch("jump", path)}
    >
      <span class="tree-label-text" use:hoverScroll
        >{shortLeafLabel(groupBy[depth], node.value)}</span
      >
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
            path={[
              ...path,
              { dimension: groupBy[depth + 1], value: child.value },
            ]}
            node={child}
            {expandedKeys}
            {childrenByKey}
            {loadingKeys}
            {highlightedKey}
            {collapsedPaths}
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
    flex: 0 0 auto;
  }
  /* The feed-visibility control reads as an icon, not a disclosure arrow: muted
     until it matters, and tinted when the group is actually hidden from the feed. */
  .tree-collapse-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #6f6f6f;
  }
  .tree-collapse-icon svg {
    width: 12px;
    height: 12px;
    display: block;
  }
  .tree-collapse-icon:hover {
    color: #cfcfcf;
  }
  .tree-collapse-icon.collapsed {
    color: #ffd24c;
  }
  .tree-fold-spacer {
    display: inline-block;
    width: 16px;
    flex: 0 0 auto;
  }
  .tree-label {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  /* The text slides on hover (see hoverScroll) so a truncated folder name can be
     read in full; the fade-out edge hints there's more to see. */
  .tree-label-text {
    display: inline-block;
    white-space: nowrap;
    will-change: transform;
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
