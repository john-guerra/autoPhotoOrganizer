<script>
  import { treeKey } from "./treeState.js";
  import { rowDomId } from "./treeKeyboard.js";
  import { pathKey } from "./feed.js";
  import { shortLeafLabel } from "./labels.js";
  import { labelParts, EMPTY_STATS } from "./folderLabel.js";
  import { descendantGroups } from "./folderTree.js";
  import GroupStateIcon from "./GroupStateIcon.svelte";
  import FolderIcon from "./FolderIcon.svelte";
  import {
    getRenderer,
    nextRendererId,
    nextAggregateRendererId,
    currentAggregateRendererId,
  } from "./groupRenderers.js";
  // Svelte 5 deprecates <svelte:self> in favor of a self-import — same
  // recursive component, no deprecation warning.
  import TreeNode from "./TreeNode.svelte";

  let {
    groupBy, // string[]
    path, // Array<{dimension,value}> — this node's own path
    node, // {value, label, count, hasChildren} — folder levels also carry
    // {children, isGroup, ownCount} from folderTree.js
    expandedKeys, // Set<string>
    childrenByKey, // Map<string, {nodes, error?}>
    loadingKeys, // Set<string>
    highlightedKey, // string|null
    focusKey = null, // treeKey of the FOCUS group ("you are here" — amber dot)
    viewKey = null, // treeKey of the VIEW group (top of viewport — eye glyph)
    cursorKey = null, // treeKey of the KEYBOARD cursor row (roving focus)
    collapsedPaths, // Array<Array<{dimension,value}>>
    snapshotKeys = new Set(), // pathKeys rendered as a snapshot strip
    // Parent-SUBTREE fold state (#142) — see TreeSidebar's own doc comment:
    // mirrors collapsedPaths/snapshotKeys, keyed the same way (pathKey
    // ignores the `subtree` flag, so a folder's plain and subtree keys are
    // the SAME string).
    aggregateKeys = new Set(),
    aggregateSnapshotKeys = new Set(),
    tokenStats = EMPTY_STATS, // library-wide token df, for folder labels
    siblingLabels = [], // every label at THIS level — the redundancy to strip
    ontoggleexpand,
    ontogglecollapse,
    onjump,
    oncontextmenu,
  } = $props();

  let depth = $derived(path.length - 1);
  let key = $derived(treeKey(path));
  // "You are here" — the two timeline anchors, as row markers.
  let isFocusHere = $derived(focusKey != null && key === focusKey);
  let isViewHere = $derived(viewKey != null && key === viewKey);
  let expanded = $derived(expandedKeys.has(key));
  let loading = $derived(loadingKeys.has(key));
  let children = $derived(childrenByKey.get(key)?.nodes ?? []);
  let childError = $derived(childrenByKey.get(key)?.error);

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
  let isFolderLevel = $derived(groupBy[depth] === "folder");
  let subfolders = $derived(isFolderLevel ? (node.children ?? []) : []);
  let isVirtual = $derived(isFolderLevel && node.isGroup === false);
  let nextDim = $derived(groupBy[depth + 1]);
  // Only a REAL group can have next-dimension children; a virtual ancestor has no
  // photos of its own, so there is nothing for the server to group.
  let wantsFetch = $derived(
    isFolderLevel ? Boolean(node.isGroup && nextDim) : node.hasChildren
  );
  let hasChildren = $derived(
    isFolderLevel ? subfolders.length > 0 || wantsFetch : node.hasChildren
  );

  function subfolderPath(value) {
    return [...path.slice(0, -1), { dimension: "folder", value }];
  }
  let subfolderLabels = $derived(subfolders.map((n) => n.label));

  // --- Feed state -----------------------------------------------------------
  // Compare against collapsedPaths directly (not via a called function) so
  // Svelte's dependency tracking — based on the reactive statement's own
  // source text, not what a called function closes over — actually re-runs
  // this when collapsedPaths changes.
  let collapsedInFeed = $derived(
    collapsedPaths.some((p) => treeKey(p) === key)
  );
  // NOTE: snapshotKeys is keyed by feed.js's `pathKey` (JSON-encoded), NOT by
  // this file's `treeKey` (delimiter-joined) — they are different strings, so
  // checking it with treeKey silently never matches and every snapshot group
  // rendered as "collapsed" here. Use pathKey for that Set specifically.
  let ownRendererId = $derived(
    !collapsedInFeed
      ? "grid"
      : snapshotKeys.has(pathKey(path))
        ? "snapshot"
        : "collapsed"
  );

  // Every real group this row speaks for. For a leaf that's just itself; for a
  // folder row with sub-folders it's the whole subtree, so one click can fold a
  // whole trip.
  let groupPaths = $derived(
    isFolderLevel ? descendantGroups(node).map(subfolderPath) : [path]
  );

  // Does this row stand for more than itself? (#142) The ONLY signal App's
  // onGroupToggle needs to pick aggregate-vs-per-leaf-vs-plain — see
  // foldPaths.js's foldTargetFor. Only `folder` ever nests, so this is false
  // for every non-folder dimension and for a folder leaf.
  let isParent = $derived(groupPaths.length > 1);
  // This row's own SUBTREE key (#142) — the same shape App's
  // cycleSubtreeAggregate writes: pathKey encodes only [dimension,value], so
  // it's the IDENTICAL string to this row's plain `pathKey(path)` — the
  // `subtree` flag never changes the key, only which Set it's tracked in.
  let subtreeKey = $derived(
    pathKey([...path.slice(0, -1), { ...path.at(-1), subtree: true }])
  );
  // A PARENT row can itself be folded as one whole-subtree band. Checked
  // before the per-group/virtual-ancestor cases below so an aggregated
  // parent's icon reflects that (a strip or a bar), never its (suppressed)
  // descendants' individual states. currentAggregateRendererId (groupRenderers.js)
  // is the SAME read App.svelte's cycleSubtreeAggregate uses — one pure
  // function, not two hand-kept ternaries that can drift (#142 review: this
  // one used to duplicate App.svelte's, and App's copy had gone stale with
  // the wrong constant). Guarded by aggregateKeys.has(subtreeKey) first, so
  // it's never asked to return "grid" here — isParent is false for anything
  // that isn't a real/virtual folder parent.
  let aggregateRendererId = $derived(
    isParent && aggregateKeys.has(subtreeKey)
      ? currentAggregateRendererId(
          subtreeKey,
          aggregateKeys,
          aggregateSnapshotKeys
        )
      : null
  );

  // A virtual ancestor has no state of its own — it reports what its descendants
  // are collectively doing, and says "mixed" when they disagree rather than
  // picking one and lying about the rest.
  let descendantStates = $derived(
    groupPaths.map((p) => {
      const k = pathKey(p);
      if (!collapsedPaths.some((c) => pathKey(c) === k)) return "grid";
      return snapshotKeys.has(k) ? "snapshot" : "collapsed";
    })
  );
  let rendererId = $derived(
    aggregateRendererId ??
      (!isVirtual
        ? ownRendererId
        : descendantStates.length &&
            descendantStates.every((s) => s === descendantStates[0])
          ? descendantStates[0]
          : "mixed")
  );
  let iconState = $derived(
    rendererId === "mixed" ? "mixed" : getRenderer(rendererId).icon
  );
  // nextAggregateRendererId (groupRenderers.js, shared with App.svelte's
  // cycleSubtreeAggregate — no more hand-copied AGGREGATE_CYCLE here). Only
  // used for a PARENT row's tooltip, so a plain leaf's preview still comes
  // from the ordinary per-group nextRendererId.
  let toggleTitle = $derived(
    rendererId === "mixed"
      ? "The groups under here are shown differently — click to show them all"
      : `${getRenderer(rendererId).label} — click for ${getRenderer(
          isParent
            ? nextAggregateRendererId(rendererId)
            : nextRendererId(rendererId)
        ).label.toLowerCase()}`
  );

  // Plain click: a PARENT folds/aggregates its WHOLE subtree, a leaf cycles
  // itself. Shift-click: a PARENT fans out to each of its groups instead
  // (VS Code-style region fold) — a leaf has nothing to fan out (no-op,
  // identical to plain). App.svelte's onGroupToggle/foldTargetFor makes this
  // call (#142); this row just hands over what it stands for (`groupPaths`)
  // always, not only when Shift/virtual — the decision moved up to App so
  // the feed header and the tree agree on it in exactly one place.
  function onToggleCollapse(event) {
    ontogglecollapse?.({ path, event, paths: groupPaths });
  }

  // A virtual ancestor is not a group, so there is no section to scroll to —
  // jump to the first real group beneath it instead. For a real folder group,
  // jump to its EXACT server value (node.groupValue): `path` carries the rebuilt
  // value, which drops a rare trailing slash and would land on an empty feed. For
  // every normal folder groupValue === the path value, so this is a no-op there.
  let jumpPath = $derived(
    isVirtual
      ? (groupPaths[0] ?? null)
      : node?.groupValue && node.groupValue !== path.at(-1)?.value
        ? [...path.slice(0, -1), { ...path.at(-1), value: node.groupValue }]
        : path
  );

  /** Right-click. Ships the facts App CANNOT recompute from the path alone —
   * isVirtual, groupPaths and the row's own subfolders come out of folderTree's
   * trie, and `expanded` lives in TreeSidebar's expandedKeys — so the menu can be
   * built without App having to rebuild the tree's state. */
  function onContextMenu(event) {
    event.preventDefault();
    oncontextmenu?.({
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
  let parts = $derived(
    isFolderLevel
      ? labelParts(node.label, { stats: tokenStats, siblings: siblingLabels })
      : [{ text: shortLeafLabel(groupBy[depth], node.value), kind: "keep" }]
  );
  // The whole truth is always one hover away.
  let fullTitle = $derived(isFolderLevel ? node.value : node.label);

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
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="tree-node-row"
    class:tree-cursor={cursorKey != null && cursorKey === key}
    role="treeitem"
    tabindex="-1"
    id={rowDomId(key)}
    data-tree-key={key}
    data-depth={depth}
    aria-selected={cursorKey != null && cursorKey === key}
    aria-expanded={hasChildren ? expanded : undefined}
    oncontextmenu={onContextMenu}
  >
    <!-- TREE structure: a disclosure triangle — shows/hides this node's CHILD
         folders here in the sidebar. -->
    {#if hasChildren}
      <button
        class="tree-fold-icon"
        title="Show/hide sub-folders in this tree (shift-click: fold all descendants)"
        aria-label="Show or hide sub-folders in the tree"
        aria-expanded={expanded}
        onclick={(e) => ontoggleexpand?.({ path, event: e, fetch: wantsFetch })}
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
      aria-label={isParent
        ? "Cycle this folder's whole subtree: full grid → aggregate snapshot → aggregate collapsed (Shift-click to fold each group beneath it instead)"
        : "Cycle this group in the feed: full grid → snapshot strip → collapsed"}
      onclick={onToggleCollapse}
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
      onclick={() => jumpPath && onjump?.(jumpPath)}
    >
      <span class="tree-label-text" use:hoverScroll={parts}
        >{#each parts as part}<span class="part-{part.kind}">{part.text}</span
          >{/each}</span
      >
    </button>
    <span class="tree-count">{node.count}</span>
    <!-- "You are here": the SAME two anchors the timeline draws, same colours.
         FOCUS = the photo you're working on (amber dot); VIEW = the top of the
         feed viewport (grey eye). App nulls `viewKey` when it coincides with
         `focusKey`, so a group you're both focused on and viewing shows just the
         amber dot — exactly how the timeline collapses its two ticks. -->
    {#if isFocusHere}
      <span
        class="here-marker here-focus"
        title="The photo you're working on is in this group"
        aria-label="Focused photo is here"
      ></span>
    {/if}
    {#if isViewHere}
      <span
        class="here-marker here-view"
        title="The top of what's on screen is in this group"
        aria-label="Current view is here"
      >
        <svg viewBox="0 0 12 9" width="12" height="9" aria-hidden="true">
          <path
            d="M1 4.5C3 1 9 1 11 4.5 9 8 3 8 1 4.5Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
          />
          <circle cx="6" cy="4.5" r="1.7" fill="currentColor" />
        </svg>
      </span>
    {/if}
  </div>
  {#if expanded}
    <ul class="tree-level">
      <!-- Sub-folders first: they came with this level's response, so they are
           already here. The next grouping dimension (if any) is fetched, and only
           ever exists for a folder that has photos of its own. -->
      {#each subfolders as child (child.value)}
        <TreeNode
          {groupBy}
          path={subfolderPath(child.value)}
          node={child}
          {expandedKeys}
          {childrenByKey}
          {loadingKeys}
          {highlightedKey}
          {focusKey}
          {viewKey}
          {cursorKey}
          {collapsedPaths}
          {snapshotKeys}
          {aggregateKeys}
          {aggregateSnapshotKeys}
          {tokenStats}
          siblingLabels={subfolderLabels}
          {ontoggleexpand}
          {ontogglecollapse}
          {onjump}
          {oncontextmenu}
        />
      {/each}
      {#if wantsFetch}
        {#if loading}
          <li class="tree-loading">Loading…</li>
        {:else if childError}
          <li class="tree-error">{childError}</li>
        {:else}
          {#each children as child (child.value)}
            <TreeNode
              {groupBy}
              path={[...path, { dimension: nextDim, value: child.value }]}
              node={child}
              {expandedKeys}
              {childrenByKey}
              {loadingKeys}
              {highlightedKey}
              {focusKey}
              {viewKey}
              {cursorKey}
              {collapsedPaths}
              {snapshotKeys}
              {aggregateKeys}
              {aggregateSnapshotKeys}
              {tokenStats}
              siblingLabels={children.map((n) => n.label)}
              {ontoggleexpand}
              {ontogglecollapse}
              {onjump}
              {oncontextmenu}
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
  /* "You are here" markers — same palette as the timeline's two ticks
     (TimelineFilter): amber focus, cool-grey eye. Pushed to the row's right edge,
     after the count. */
  .here-marker {
    margin-left: 4px;
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    line-height: 0;
  }
  .here-focus {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ffd24c; /* timeline focus amber */
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  }
  .here-view {
    color: #b9c2cc; /* timeline view / eye grey */
  }
  .tree-node.highlighted > .tree-node-row {
    background: #2a2a2a;
    border-radius: 4px;
  }
  /* The keyboard cursor — a blue selection ring, distinct from the grey reveal
     highlight and the amber-dot / eye "you are here" markers. */
  .tree-node-row.tree-cursor {
    background: rgba(76, 154, 255, 0.16);
    box-shadow: inset 0 0 0 1px rgba(76, 154, 255, 0.55);
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
