<script>
  import { createEventDispatcher } from "svelte";
  import { treeKey } from "./treeState.js";
  import { pathKey } from "./feed.js";
  import { shortLeafLabel } from "./labels.js";
  import GroupStateIcon from "./GroupStateIcon.svelte";
  import { getRenderer, nextRendererId } from "./groupRenderers.js";

  export let groupBy; // string[]
  export let path; // Array<{dimension,value}> — this node's own path
  export let node; // {value, label, count, hasChildren}
  export let expandedKeys; // Set<string>
  export let childrenByKey; // Map<string, {nodes, error?}>
  export let loadingKeys; // Set<string>
  export let highlightedKey; // string|null
  export let collapsedPaths; // Array<Array<{dimension,value}>>
  export let snapshotKeys = new Set(); // pathKeys rendered as a snapshot strip

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
  // The group's FEED state — same tri-state (and same icon) the feed's section
  // headers show, so the sidebar and the feed never disagree about a group.
  //
  // NOTE: snapshotGroupKeys is keyed by feed.js's `pathKey` (JSON-encoded), NOT
  // by this file's `treeKey` (delimiter-joined) — they are different strings, so
  // checking it with treeKey silently never matches and every snapshot group
  // rendered as "collapsed" here. Use pathKey for that Set specifically.
  // Which widget draws this group's photos in the feed — same registry the feed
  // uses, so the sidebar icon can never disagree with the header's.
  $: rendererId = !collapsedInFeed
    ? "grid"
    : snapshotKeys.has(pathKey(path))
      ? "snapshot"
      : "collapsed";
  // Tooltip from the registry — the feed header derives its own the same way, so
  // a new renderer needs no second edit here.
  $: toggleTitle = `${getRenderer(rendererId).label} — click for ${getRenderer(
    nextRendererId(rendererId)
  ).label.toLowerCase()}`;

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
    <!-- FEED state: the SAME tri-state icon the feed's section headers use
         (grid → strip → bar), deliberately not a triangle so it can't be
         mistaken for the tree's disclosure control above. Clicking cycles the
         group exactly like clicking its header in the feed does. -->
    <button
      class="tree-collapse-icon"
      class:not-grid={rendererId !== "grid"}
      title={toggleTitle}
      aria-label="Cycle this group in the feed: full grid → snapshot strip → collapsed"
      on:click={(e) => dispatch("toggleCollapse", { path, event: e })}
    >
      <GroupStateIcon state={getRenderer(rendererId).icon} />
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
            {snapshotKeys}
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
  .tree-collapse-icon:hover {
    color: #cfcfcf;
  }
  /* Amber once the group is not showing in full — matches the feed header. */
  .tree-collapse-icon.not-grid {
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
