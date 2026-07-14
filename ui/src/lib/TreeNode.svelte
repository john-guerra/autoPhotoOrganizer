<script>
  import { createEventDispatcher } from "svelte";
  import { treeKey } from "./treeState.js";
  import { pathKey } from "./feed.js";
  import { shortLeafLabel } from "./labels.js";
  import { labelParts, EMPTY_STATS } from "./folderLabel.js";
  import { descendantGroups } from "./folderTree.js";
  import GroupStateIcon from "./GroupStateIcon.svelte";
  import FolderIcon from "./FolderIcon.svelte";
  import { getRenderer, nextRendererId } from "./groupRenderers.js";

  export let groupBy; // string[]
  export let path; // Array<{dimension,value}> — this node's own path
  export let node; // {value, label, count, hasChildren} — folder levels also carry
  // {children, isGroup, ownCount} from folderTree.js
  export let expandedKeys; // Set<string>
  export let childrenByKey; // Map<string, {nodes, error?}>
  export let loadingKeys; // Set<string>
  export let highlightedKey; // string|null
  export let collapsedPaths; // Array<Array<{dimension,value}>>
  export let snapshotKeys = new Set(); // pathKeys rendered as a snapshot strip
  export let tokenStats = EMPTY_STATS; // library-wide token df, for folder labels
  export let siblingLabels = []; // every label at THIS level — the redundancy to strip

  const dispatch = createEventDispatcher();

  $: depth = path.length - 1;
  $: key = treeKey(path);
  $: expanded = expandedKeys.has(key);
  $: loading = loadingKeys.has(key);
  $: children = childrenByKey.get(key)?.nodes ?? [];
  $: childError = childrenByKey.get(key)?.error;

  // --- Folder levels are a real hierarchy ------------------------------------
  // Folders are the one dimension whose values nest: the server hands us every
  // folder for this level in ONE response, and folderTree.js turns that flat list
  // into a trie. So a folder row's sub-folders are already in hand — expanding one
  // costs no fetch — and a row can stand for a folder that has no photos itself
  // (a "virtual ancestor" the trie invented to hold its children together).
  //
  // Sub-folder rows keep the SAME path length as this row: the feed's groupBy has
  // one `folder` dimension, so a group path is [.., {folder, absPath}] no matter
  // how deep the folder sits. The nesting is a fact about the paths, not about the
  // grouping. That is what keeps treeKey/pathKey matching collapsedPaths.
  $: isFolderLevel = groupBy[depth] === "folder";
  $: subfolders = isFolderLevel ? (node.children ?? []) : [];
  $: isVirtual = isFolderLevel && node.isGroup === false;
  $: nextDim = groupBy[depth + 1];
  // Only a REAL group can have next-dimension children; a virtual ancestor has no
  // photos of its own, so there is nothing for the server to group.
  $: wantsFetch = isFolderLevel
    ? Boolean(node.isGroup && nextDim)
    : node.hasChildren;
  $: hasChildren = isFolderLevel
    ? subfolders.length > 0 || wantsFetch
    : node.hasChildren;

  $: subfolderPath = (value) => [
    ...path.slice(0, -1),
    { dimension: "folder", value },
  ];
  $: subfolderLabels = subfolders.map((n) => n.label);

  // --- Feed state -----------------------------------------------------------
  // Compare against collapsedPaths directly (not via a called function) so
  // Svelte's dependency tracking — based on the reactive statement's own
  // source text, not what a called function closes over — actually re-runs
  // this when collapsedPaths changes.
  $: collapsedInFeed = collapsedPaths.some((p) => treeKey(p) === key);
  // NOTE: snapshotKeys is keyed by feed.js's `pathKey` (JSON-encoded), NOT by
  // this file's `treeKey` (delimiter-joined) — they are different strings, so
  // checking it with treeKey silently never matches and every snapshot group
  // rendered as "collapsed" here. Use pathKey for that Set specifically.
  $: ownRendererId = !collapsedInFeed
    ? "grid"
    : snapshotKeys.has(pathKey(path))
      ? "snapshot"
      : "collapsed";

  // Every real group this row speaks for. For a leaf that's just itself; for a
  // folder row with sub-folders it's the whole subtree, so one click can fold a
  // whole trip.
  $: groupPaths = isFolderLevel
    ? descendantGroups(node).map(subfolderPath)
    : [path];

  // A virtual ancestor has no state of its own — it reports what its descendants
  // are collectively doing, and says "mixed" when they disagree rather than
  // picking one and lying about the rest.
  $: descendantStates = groupPaths.map((p) => {
    const k = pathKey(p);
    if (!collapsedPaths.some((c) => pathKey(c) === k)) return "grid";
    return snapshotKeys.has(k) ? "snapshot" : "collapsed";
  });
  $: rendererId = !isVirtual
    ? ownRendererId
    : descendantStates.length &&
        descendantStates.every((s) => s === descendantStates[0])
      ? descendantStates[0]
      : "mixed";
  $: iconState =
    rendererId === "mixed" ? "mixed" : getRenderer(rendererId).icon;
  $: toggleTitle =
    rendererId === "mixed"
      ? "The groups under here are shown differently — click to show them all"
      : `${getRenderer(rendererId).label} — click for ${getRenderer(
          nextRendererId(rendererId)
        ).label.toLowerCase()}`;

  // Clicking a virtual ancestor's icon has to act on the groups beneath it —
  // it has none of its own. Shift-click does the same for a real folder that
  // also has sub-folders ("fold this whole trip").
  function onToggleCollapse(event) {
    const foldSubtree = isVirtual || (event.shiftKey && subfolders.length > 0);
    dispatch("toggleCollapse", {
      path,
      event,
      paths: foldSubtree ? groupPaths : undefined,
    });
  }

  // A virtual ancestor is not a group, so there is no section to scroll to —
  // jump to the first real group beneath it instead.
  $: jumpPath = isVirtual ? (groupPaths[0] ?? null) : path;

  /** Right-click. Ships the facts App CANNOT recompute from the path alone —
   * isVirtual, groupPaths and the row's own subfolders come out of folderTree's
   * trie, and `expanded` lives in TreeSidebar's expandedKeys — so the menu can be
   * built without App having to rebuild the tree's state. */
  function onContextMenu(event) {
    event.preventDefault();
    dispatch("contextmenu", {
      x: event.clientX,
      y: event.clientY,
      path,
      jumpPath,
      groupPaths,
      isVirtual,
      isFolder: isFolderLevel,
      folderPath: isFolderLevel ? node.value : null,
      hasChildren,
      expanded,
      rendererId,
      // TreeSidebar seeds its expand-BFS from {node, path, depth} rows, so a
      // subtree-scoped "expand everything under here" needs the node itself.
      node,
      depth,
    });
  }

  // --- Label ----------------------------------------------------------------
  // Folder names are mostly redundancy (the year the parent row already states,
  // the _peq every folder carries); folderLabel.js decides which tokens earn a
  // pixel. Other dimensions are already short — leave them alone.
  $: parts = isFolderLevel
    ? labelParts(node.label, { stats: tokenStats, siblings: siblingLabels })
    : [{ text: shortLeafLabel(groupBy[depth], node.value), kind: "keep" }];
  // The whole truth is always one hover away.
  $: fullTitle = isFolderLevel ? node.value : node.label;

  // How fast a clipped folder name slides aside on hover. Slow enough to READ as
  // it moves (you are trying to see the hidden head of the name, not be startled
  // by it), with a floor so a short name isn't sluggish and a ceiling so a very
  // long one doesn't turn into a ticker.
  //
  // Third pass, and the direction has been the same each time: SLOWER. 200px/s
  // read as a snap, 85px/s was still faster than the eye can track a name it is
  // trying to read. ~50px/s over a ~1.7s ceiling is a reveal you can follow —
  // a 200px-long hidden head takes about a second, which is roughly how long it
  // takes to read one.
  const REVEAL_PX_PER_S = 50;
  const REVEAL_MIN_S = 0.3;
  const REVEAL_MAX_S = 1.7;
  const RETURN_S = 0.25;

  /** Svelte action: the row shows the END of the name (see the CSS); hovering
   * slides it back to the RIGHT to reveal the clipped head, then returns.
   * Measures the real overflow — CSS alone can't know it — and only animates, and
   * only fades its left edge, when there IS something hidden. */
  function hoverScroll(el, _parts) {
    let leaving;
    const distance = () =>
      Math.max(0, el.scrollWidth - el.parentElement.clientWidth);
    function mark() {
      el.parentElement?.classList.toggle("clipped", distance() > 0);
    }
    function enter() {
      clearTimeout(leaving);
      const d = distance();
      if (d <= 0) return;
      // A reveal, not a ticker — but not a flinch either. An early pass
      // over-corrected a 40px/s crawl into ~200px/s capped at 0.35s, which reads
      // as a snap: the eye has to re-find the text after it has already stopped.
      // A slow rate over a long ceiling lets you actually FOLLOW the name as it
      // slides, which is the point of moving it at all.
      const seconds = Math.min(
        REVEAL_MAX_S,
        Math.max(REVEAL_MIN_S, d / REVEAL_PX_PER_S)
      );
      el.style.transition = `transform ${seconds}s cubic-bezier(0.2, 0.8, 0.2, 1)`;
      el.style.transform = `translateX(${d}px)`;
    }
    function leave() {
      // Coming back is a return, not a reveal — nothing to read on the way, so it
      // stays quicker than the outward slide.
      el.style.transition = `transform ${RETURN_S}s ease-out`;
      el.style.transform = "translateX(0)";
      leaving = setTimeout(() => (el.style.transition = ""), RETURN_S * 1000);
    }
    mark();
    el.parentElement.addEventListener("mouseenter", enter);
    el.parentElement.addEventListener("mouseleave", leave);
    return {
      update: mark, // the label changed (filter, rescan) — re-measure
      destroy() {
        clearTimeout(leaving);
        el.parentElement?.removeEventListener("mouseenter", enter);
        el.parentElement?.removeEventListener("mouseleave", leave);
      },
    };
  }
</script>

<li class="tree-node" class:highlighted={highlightedKey === key}>
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="tree-node-row" on:contextmenu={onContextMenu}>
    <!-- TREE structure: a disclosure triangle — shows/hides this node's CHILD
         folders here in the sidebar. -->
    {#if hasChildren}
      <button
        class="tree-fold-icon"
        title="Show/hide sub-folders in this tree (shift-click: fold all descendants)"
        aria-label="Show or hide sub-folders in the tree"
        aria-expanded={expanded}
        on:click={(e) =>
          dispatch("toggleExpand", { path, event: e, fetch: wantsFetch })}
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
      on:click={onToggleCollapse}
    >
      <GroupStateIcon state={iconState} />
    </button>
    <!-- OUTSIDE .tree-label on purpose: hoverScroll measures the label span's
         scrollWidth against its PARENT's clientWidth, so an icon inside the
         button would eat into that width and the reveal would mis-measure what
         is actually clipped. Hollow = a virtual ancestor (a directory, but no
         row in the index, so nothing to rename or remove). -->
    {#if isFolderLevel}
      <FolderIcon virtual={isVirtual} />
    {/if}
    <button
      class="tree-label"
      class:virtual={isVirtual}
      title={fullTitle}
      disabled={!jumpPath}
      on:click={() => jumpPath && dispatch("jump", jumpPath)}
    >
      <span class="tree-label-text" use:hoverScroll={parts}
        >{#each parts as part}<span class="part-{part.kind}">{part.text}</span
          >{/each}</span
      >
    </button>
    <span class="tree-count">{node.count}</span>
  </div>
  {#if expanded}
    <ul class="tree-level">
      <!-- Sub-folders first: they came with this level's response, so they are
           already here. The next grouping dimension (if any) is fetched, and only
           ever exists for a folder that has photos of its own. -->
      {#each subfolders as child (child.value)}
        <svelte:self
          {groupBy}
          path={subfolderPath(child.value)}
          node={child}
          {expandedKeys}
          {childrenByKey}
          {loadingKeys}
          {highlightedKey}
          {collapsedPaths}
          {snapshotKeys}
          {tokenStats}
          siblingLabels={subfolderLabels}
          on:toggleExpand
          on:toggleCollapse
          on:jump
          on:contextmenu
        />
      {/each}
      {#if wantsFetch}
        {#if loading}
          <li class="tree-loading">Loading…</li>
        {:else if childError}
          <li class="tree-error">{childError}</li>
        {:else}
          {#each children as child (child.value)}
            <svelte:self
              {groupBy}
              path={[...path, { dimension: nextDim, value: child.value }]}
              node={child}
              {expandedKeys}
              {childrenByKey}
              {loadingKeys}
              {highlightedKey}
              {collapsedPaths}
              {snapshotKeys}
              {tokenStats}
              siblingLabels={children.map((n) => n.label)}
              on:toggleExpand
              on:toggleCollapse
              on:jump
              on:contextmenu
            />
          {/each}
        {/if}
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
  /* Clip the HEAD, not the tail.
     A folder name puts its date first and its subject last
     ("2002_12Dec_10_harbour_peq"), so a normal left-anchored ellipsis spends
     the whole row on the date and cuts off the one word you were looking for —
     and here the head is redundant anyway: the parent row directly above already
     says "2002". direction:rtl on the clipper flips WHICH END overflows (the
     inner span stays ltr, so the text itself is unchanged); the fade on the left
     edge says there's more, and hovering slides it back into view. */
  .tree-label {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    direction: rtl;
    text-align: left;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  /* Only fade the left edge when something IS hidden behind it (set by
     hoverScroll, which is the only thing that can measure the overflow). */
  .tree-label.clipped {
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 14px);
    mask-image: linear-gradient(to right, transparent 0, #000 14px);
  }
  /* The text slides on hover (see hoverScroll) so the clipped head can be read;
     the full path is in the row's title either way. */
  .tree-label-text {
    display: inline-block;
    direction: ltr;
    white-space: nowrap;
    will-change: transform;
  }
  .tree-label:hover {
    text-decoration: underline;
  }
  /* A row for a folder that holds no photos itself — it exists to hold its
     children. It still jumps (to the first group beneath it), but it shouldn't
     shout. */
  .tree-label.virtual {
    color: #b9b9b9;
  }
  /* Layering, the point of the whole exercise: the token that identifies this
     folder is bright, the boilerplate every sibling repeats recedes. Nothing is
     deleted that the eye needs — it just stops competing. */
  .part-keep {
    color: inherit;
  }
  .part-dim,
  .part-ellipsis {
    color: #8a8a8a;
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
