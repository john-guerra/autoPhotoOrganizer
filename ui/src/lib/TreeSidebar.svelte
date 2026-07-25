<script>
  import { tick } from "svelte";
  import { moveCursor, typeAheadTarget, rowDomId } from "./treeKeyboard.js";
  import { fetchTreeNode } from "./api.js";
  import { treeKey, collapseDescendants } from "./treeState.js";
  import { buildFolderTree, isFolderNode, chainTo } from "./folderTree.js";
  import { EMPTY_STATS } from "./folderLabel.js";
  import TreeNode from "./TreeNode.svelte";

  let {
    groupBy, // string[]
    collapsedPaths, // Array<Array<{dimension,value}>>
    snapshotKeys = new Set(), // pathKeys rendered as a snapshot strip
    // Parent-SUBTREE fold state (#142) — mirrors collapsedPaths/snapshotKeys:
    // aggregateKeys is the subset of collapsed groups that are a whole-subtree
    // fold (keyed the SAME way — pathKey ignores the `subtree` flag, so a
    // folder's plain and subtree keys coincide), aggregateSnapshotKeys the
    // subset of those shown as a strip rather than a bar. Owned by App;
    // TreeNode only reads them, exactly like the other two.
    aggregateKeys = new Set(),
    aggregateSnapshotKeys = new Set(),
    filter = null,
    sort = null, // feed sort — date sorts change the date-group order
    refreshToken = 0, // bump to force a reload when the index changes
    // Library-wide token frequencies, for the folder label rule (folderLabel.js).
    // Owned by App (which already has the library list) so the feed's headers and
    // these rows judge a folder name by exactly the same corpus.
    tokenStats = EMPTY_STATS,
    // "You are here" — the same two anchors the timeline draws, as tree markers:
    // the FOCUS group (the photo you're working on) and the VIEW group (top of the
    // feed viewport). treeKey strings; App resolves the coincide case (view null
    // when it equals focus). See TreeNode's here-marker.
    focusKey = null,
    viewKey = null,
    // "Follow here": when on, App calls revealPath() as the feed's VIEW anchor
    // moves, so the tree keeps the location revealed + scrolled into view. This
    // component only renders the toggle; App owns the (persisted) state and drives
    // the reveal. See docs/superpowers/specs/2026-07-17-tree-follow-here-design.md.
    followHere = false,
    onfollowtoggle,
    ontoggle,
    onjump,
    oncontextmenu,
  } = $props();

  let navEl = $state(); // for revealPath's scrollIntoView

  // --- Keyboard navigation (VS Code-style) ----------------------------------
  // The .tree-scroll region is one tab stop; treeCursorKey is the roving cursor.
  // Movement reads the ACTUAL rendered rows (`.tree-node-row`, in order) so it
  // always matches what's on screen across any grouping/compaction, and reuses the
  // rows' own fold-icon / label handlers for expand-collapse / jump. See
  // docs/superpowers/specs/2026-07-17-tree-keyboard-nav-design.md.
  let scrollEl = $state();
  let treeCursorKey = $state(null);
  let typeAheadBuffer = "";
  let typeAheadTimer;

  /** Focus the tree (called by App's `T` shortcut via bind:this). */
  export function focusTree() {
    scrollEl?.focus();
  }

  const visibleRows = () => [
    ...(scrollEl?.querySelectorAll(".tree-node-row") ?? []),
  ];
  const cursorIndexIn = (rows) =>
    rows.findIndex((r) => r.dataset.treeKey === treeCursorKey);

  /** Move the cursor to row `index` and scroll it into view. */
  function cursorTo(rows, index) {
    if (index < 0 || index >= rows.length) return;
    treeCursorKey = rows[index].dataset.treeKey;
    rows[index].scrollIntoView({ block: "nearest" });
  }

  function onTreeFocus() {
    // Land the cursor somewhere sensible the first time (or after it scrolled
    // out of the rendered set): the current view/focus row if visible, else top.
    const rows = visibleRows();
    if (!rows.length) return;
    if (cursorIndexIn(rows) >= 0) return;
    const here = rows.findIndex(
      (r) => r.dataset.treeKey === viewKey || r.dataset.treeKey === focusKey
    );
    cursorTo(rows, here >= 0 ? here : 0);
  }

  /** A click anywhere in a row moves the cursor there too, so keyboard and mouse
   *  agree on "where I am". */
  function onTreeClick(e) {
    const row = e.target.closest?.(".tree-node-row");
    if (row?.dataset.treeKey) treeCursorKey = row.dataset.treeKey;
  }

  function onTreeKeydown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser combos alone
    const rows = visibleRows();
    if (!rows.length) return;
    let idx = cursorIndexIn(rows);
    if (idx < 0) idx = 0;
    const row = rows[idx];
    const fold = row.querySelector(".tree-fold-icon");
    const expanded = fold?.getAttribute("aria-expanded") === "true";
    const rowH = row.getBoundingClientRect().height || 24;
    const pageSize = Math.max(1, Math.floor(scrollEl.clientHeight / rowH) - 1);

    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        cursorTo(rows, moveCursor(rows.length, idx, "down"));
        break;
      case "ArrowUp":
        cursorTo(rows, moveCursor(rows.length, idx, "up"));
        break;
      case "Home":
        cursorTo(rows, moveCursor(rows.length, idx, "home"));
        break;
      case "End":
        cursorTo(rows, moveCursor(rows.length, idx, "end"));
        break;
      case "PageDown":
        cursorTo(rows, moveCursor(rows.length, idx, "pagedown", pageSize));
        break;
      case "PageUp":
        cursorTo(rows, moveCursor(rows.length, idx, "pageup", pageSize));
        break;
      case "ArrowRight":
        if (fold && !expanded)
          fold.click(); // expand
        else if (fold && expanded) cursorTo(rows, idx + 1); // first child
        // leaf: nothing to do
        break;
      case "ArrowLeft":
        if (fold && expanded)
          fold.click(); // collapse
        else {
          // move to the parent: nearest row above at a shallower depth
          const depth = Number(row.dataset.depth);
          for (let j = idx - 1; j >= 0; j--) {
            if (Number(rows[j].dataset.depth) < depth) {
              cursorTo(rows, j);
              break;
            }
          }
        }
        break;
      case "Enter":
      case " ":
        row.querySelector(".tree-label")?.click(); // jump the feed
        break;
      case "Escape":
        // Hand keyboard control back to the photo feed. The feed's window-level
        // shortcut handler stands down while focus is inside .tree-sidebar
        // (App.svelte), so blurring the tree is all it takes for arrows / rating
        // to act on the grid again — the feed's "focused photo" is app state, not
        // DOM focus, so nothing else needs re-focusing. This is the way out that
        // Tab isn't: Tab follows the browser's tab order, not "into the grid".
        scrollEl.blur();
        break;
      default:
        if (e.key.length === 1) {
          // type-ahead: accumulate, reset after a short idle (the standard buffer,
          // not a state "settle" — there is no event for "stopped typing").
          clearTimeout(typeAheadTimer);
          typeAheadBuffer += e.key;
          typeAheadTimer = setTimeout(() => (typeAheadBuffer = ""), 800);
          const labels = rows.map((r) =>
            (r.querySelector(".tree-label")?.textContent ?? "").trim()
          );
          const target = typeAheadTarget(labels, idx, typeAheadBuffer);
          if (target >= 0) cursorTo(rows, target);
        } else handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  let rootTotal = $state(null);
  let rootNodes = $state([]);
  /** Why the tree is empty, when it is empty because something FAILED rather
   *  than because the library is. Rendered — an empty tree that stays silent is
   *  the app telling the user they have no photos. */
  let rootError = $state("");
  let childrenByKey = $state(new Map()); // treeKey(path) -> { nodes, error? }
  let expandedKeys = $state(new Set());
  let loadingKeys = $state(new Set());
  let highlightedKey = $state(null);
  // Folders the user DELIBERATELY collapsed (via the fold icon). "Follow here"
  // reveals the feed's location by expanding branches, but it must NOT reopen a
  // folder the user closed on purpose — otherwise following silently undoes their
  // collapse (the #125 collapse-survives-a-filter-change guarantee). Not reactive
  // (only revealPath reads it, imperatively); a plain Set is enough.
  const manuallyCollapsedKeys = new Set();

  /** Folder values nest; every other dimension's values are flat. The server can
   * only hand us the flat list (folders is a flat table — the hierarchy lives in
   * the path strings), so we build the tree here, once per level. */
  function shapeLevel(nodes, depth) {
    return groupBy[depth] === "folder" ? buildFolderTree(nodes) : nodes;
  }

  async function loadRoot() {
    try {
      rootError = "";
      const { total, nodes } = await fetchTreeNode({
        groupBy,
        path: [],
        filter,
        sort,
      });
      rootTotal = total;
      rootNodes = shapeLevel(nodes, 0);
    } catch (e) {
      // A swallowed failure here rendered as an EMPTY TREE — indistinguishable
      // from "you have no photos", which is a lie about the user's library and
      // sends them looking for a scan bug that doesn't exist. Say what happened.
      rootTotal = null;
      rootNodes = [];
      rootError = e?.message || "couldn't load the folder tree";
    }
  }

  // An expanded key (a tree path) is only meaningful under the groupBy ORDER it
  // was opened in, so a groupBy change starts the tree fresh — and expanded, the
  // way it always has. But a mere FILTER/sort/refresh change keeps the same
  // hierarchy, so it must KEEP the user's collapse/expand choices instead of
  // re-opening everything: re-expanding the whole tree on every search keystroke
  // is exactly the thing #125 reported. `expandedForGroupBy` is the signature of
  // the hierarchy the current expand state belongs to; `reloadEpoch` drops a
  // superseded reload's late writes when filters change in quick succession.
  let expandedForGroupBy = null;
  let reloadEpoch = 0;

  async function resetAndLoad() {
    const sig = JSON.stringify(groupBy);
    const sameHierarchy = sig === expandedForGroupBy;
    expandedForGroupBy = sig;
    const mine = ++reloadEpoch;

    childrenByKey = new Map();
    loadingKeys = new Set();
    highlightedKey = null;
    // Only a new hierarchy invalidates the expand set; a filter change keeps it.
    if (!sameHierarchy) {
      expandedKeys = new Set();
      manuallyCollapsedKeys.clear(); // old paths mean nothing under a new hierarchy
      // NOT the fix for #172's crash — $effect runs AFTER the render that
      // pairs the NEW groupBy with the still-stale rootNodes, so by the time
      // this line executes, TreeNode has already rendered once (or would have
      // crashed already) against the old data. Verified directly: with only
      // this reset and no guard in descendantGroups, the crash still
      // reproduced. The actual backstop is `node.children ?? []` in
      // folderTree.js's descendantGroups/chainTo. What clearing rootNodes
      // HERE does is shrink how long that stale pairing can linger across
      // whatever renders happen before loadRoot() resolves — worthwhile (a
      // folder-grouped node briefly mislabelled under the old dimension is a
      // real, if minor, UX gap) but not load-bearing for the crash itself.
      rootNodes = [];
    }

    await loadRoot();
    if (mine !== reloadEpoch) return;

    if (!sameHierarchy) {
      // New hierarchy → open by default: the tree is a map of the library, and a
      // map you have to unfold one node at a time isn't much of a map. expandAll()
      // is capped and reports when it stops, so a huge library degrades to
      // "expanded as far as is sane" rather than a fetch storm. Grouping by folder
      // ALONE is a hierarchy too (folderTree.js), so this fires for it as well.
      if (groupBy.length > 1 || groupBy.includes("folder")) expandAll();
    } else if (expandedKeys.size) {
      // Same hierarchy → keep what the user opened; just repopulate the fetched
      // (next-dimension) child levels behind those still-open nodes, since the
      // filter/sort may have changed which photos each group holds.
      await refetchExpanded(mine);
    }
  }

  /** Re-fetch the grouping-dimension child levels behind the currently expanded
   * nodes WITHOUT changing which nodes are expanded — the reload path for a
   * filter/sort change that leaves the hierarchy (and the user's expand choices)
   * intact. Folder sub-levels ride the trie and need no fetch, so this only walks
   * down through open nodes re-requesting the levels that do (childRows). */
  async function refetchExpanded(mine) {
    let frontier = rootNodes.map((node) => ({
      node,
      path: [{ dimension: groupBy[0], value: node.value }],
      depth: 0,
    }));
    while (frontier.length) {
      const nextFrontier = [];
      for (const row of frontier) {
        if (!expandedKeys.has(treeKey(row.path))) continue;
        const kids = await childRows(row);
        if (mine !== reloadEpoch) return; // a newer reload superseded this one
        nextFrontier.push(...kids);
      }
      frontier = nextFrontier;
    }
  }
  $effect(() => {
    // Explicit reactive dependencies, matching the old `$:` statement's list.
    // resetAndLoad reads groupBy/filter/sort itself (via loadRoot, synchronously
    // before its first await), but refreshToken is a pure "bump to reload"
    // signal nothing else reads — list it explicitly so it still tracks.
    void groupBy;
    void filter;
    void sort;
    void refreshToken;
    resetAndLoad();
  });

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
  let expandingAll = $state(false);
  let expandAllNote = $state("");

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

  function expandAll() {
    return expandFrom(
      rootNodes.map((node) => ({
        node,
        path: [{ dimension: groupBy[0], value: node.value }],
        depth: 0,
      }))
    );
  }

  /** Expand every level beneath `seed` (a {node, path, depth} row, the shape
   * childRows speaks). Shared by the sidebar's "Expand all" and by the
   * right-click menu's "Expand all sub-folders", so a subtree expand can't drift
   * from the whole-tree one — same BFS, same fetch/row ceilings, same note when
   * it stops early. */
  async function expandFrom(seed) {
    if (expandingAll) return;
    expandingAll = true;
    expandAllNote = "";
    try {
      const next = new Set(expandedKeys);
      let frontier = seed;
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
      // Anything now expanded is no longer "kept closed" (covers Expand all and
      // the right-click expand-subtree).
      for (const k of next) manuallyCollapsedKeys.delete(k);
      expandAllNote = truncated;
    } finally {
      expandingAll = false;
    }
  }

  function collapseAll() {
    expandedKeys = new Set();
    // A blanket collapse is a fresh start, not a set of per-folder "keep closed"
    // choices — clear the intent so Follow can still reveal the current spot.
    manuallyCollapsedKeys.clear();
    expandAllNote = "";
  }

  function handleToggleExpand({ path, event, fetch }) {
    const key = treeKey(path);
    if (expandedKeys.has(key)) {
      // Collapsing: remember it so "Follow here" won't reopen it.
      manuallyCollapsedKeys.add(key);
      expandedKeys = event.shiftKey
        ? collapseDescendants(expandedKeys, path)
        : deleteKey(expandedKeys, key);
    } else {
      // Re-expanding by hand clears the "keep closed" intent.
      manuallyCollapsedKeys.delete(key);
      expandedKeys = new Set(expandedKeys).add(key);
      // Sub-folders came with this level's response — only a deeper GROUPING
      // dimension costs a request. Fetching for a folder row that has none would
      // ask the server to group by nothing.
      if (fetch) loadChildren(path);
    }
  }

  function handleToggleCollapse({ path, event, paths }) {
    event.stopPropagation();
    // Forward the event too: App needs the shiftKey to decide "fold this group"
    // vs "fold all of its leaves" (VS Code-style folding). `paths` is set when the
    // row stands for several groups at once (a virtual folder ancestor, or a
    // shift-click on a folder that has sub-folders) — App applies the cycle to all
    // of them together.
    ontoggle?.({ path, event, paths });
  }

  function handleJump(path) {
    onjump?.(path);
  }

  /** Right-click on a row. The expand/collapse of a subtree is handled HERE, not
   * in App: `expandedKeys` is sidebar-local state, and App has no way to reach
   * it. Everything else is App's (it owns the feed), so the event goes up with a
   * callback the menu can invoke for the part that is ours. */
  function handleContextMenu(detail) {
    oncontextmenu?.({
      ...detail,
      toggleDescendants: () => {
        if (detail.expanded) {
          // Fold this row's whole subtree, leaving the row itself open — the same
          // thing shift-clicking its disclosure triangle does.
          expandedKeys = collapseDescendants(expandedKeys, detail.path);
        } else {
          expandFrom([
            { node: detail.node, path: detail.path, depth: detail.depth },
          ]);
        }
      },
    });
  }

  /** Walks `targetPath` from the root, fetching + expanding each level as
   * needed, then highlights the resulting node — called by App.svelte's
   * "reveal current location" button via bind:this. */
  export async function revealPath(
    targetPath,
    { respectManualCollapse = false } = {}
  ) {
    // A key the user deliberately collapsed. When `respectManualCollapse` (the
    // "Follow here" caller), hitting one on the way down means the target lives
    // inside a folder the user closed on purpose — stop, leave it closed, and
    // don't move the highlight. The manual "reveal current location" button passes
    // the default (false) and opens everything, because the user asked to see it.
    const blockedByCollapse = (key) =>
      respectManualCollapse && manuallyCollapsedKeys.has(key);

    let prefix = [];
    for (const seg of targetPath) {
      if (prefix.length) {
        const pk = treeKey(prefix);
        if (blockedByCollapse(pk)) return;
        expandedKeys = new Set(expandedKeys).add(pk);
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
          const k = treeKey([
            ...prefix,
            { dimension: "folder", value: node.value },
          ]);
          if (blockedByCollapse(k)) return;
          next.add(k);
        }
        expandedKeys = next;
      }
      prefix = [...prefix, seg];
    }
    highlightedKey = treeKey(targetPath);
    // Bring the revealed row to the MIDDLE of the scroll region, so "Follow here"
    // keeps the current location centred (with room above and below to see where
    // you're headed) rather than pinned to an edge. Wait a tick so the
    // just-expanded branches have rendered and the highlighted <li> exists.
    await tick();
    navEl
      ?.querySelector(".tree-node.highlighted")
      ?.scrollIntoView({ block: "center" });
  }

  // A folder grouping is a hierarchy even on its own, so "Expand all" is useful
  // with a single folder dimension — it wasn't when every level was flat.
  let canExpandAll = $derived(groupBy.length > 1 || groupBy.includes("folder"));

  // What a row's siblings are called is what tells us which of its tokens are
  // redundant (see folderLabel.js) — so every level passes its own labels down.
  let rootLabels = $derived(rootNodes.map((n) => n.label));
</script>

<nav class="tree-sidebar" aria-label="Library hierarchy" bind:this={navEl}>
  <div class="tree-root">
    <span class="tree-root-label">Library</span>
    <span class="tree-root-count">{rootTotal ?? "…"}</span>
  </div>
  <div class="tree-actions">
    <button
      class="tree-action"
      title="Expand every group in the tree"
      disabled={expandingAll || !canExpandAll}
      onclick={expandAll}
    >
      {expandingAll ? "Expanding…" : "Expand all"}
    </button>
    <button
      class="tree-action"
      title="Collapse every group in the tree"
      disabled={expandingAll || expandedKeys.size === 0}
      onclick={collapseAll}
    >
      Collapse all
    </button>
    <label
      class="tree-follow"
      title="Keep the feed's location in view in the tree — the tree scrolls to (and opens) wherever the feed is as you scroll"
    >
      <input
        type="checkbox"
        checked={followHere}
        onchange={(e) => onfollowtoggle?.(e.currentTarget.checked)}
      />
      <span class="tree-follow-eye" aria-hidden="true">👁</span>
      Follow
    </label>
  </div>
  {#if rootError}
    <p class="tree-error" role="alert">
      Couldn't load the folder tree: {rootError}
      <button class="tree-action" onclick={loadRoot}>Retry</button>
    </p>
  {/if}
  {#if expandAllNote}
    <p class="tree-note" role="status">{expandAllNote}</p>
  {/if}
  <!-- Only the node list scrolls; the Library header + actions row above stay
       pinned (so Expand/Collapse/Follow are always reachable, and "Follow here"
       auto-scrolling this list never carries the controls off-screen). This is
       ALSO the keyboard tree: one tab stop (role=tree), a roving cursor exposed
       via aria-activedescendant, driven by onTreeKeydown. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="tree-scroll"
    bind:this={scrollEl}
    role="tree"
    tabindex="0"
    aria-label="Library folders — arrow keys to navigate, Enter to open"
    aria-activedescendant={treeCursorKey ? rowDomId(treeCursorKey) : undefined}
    onkeydown={onTreeKeydown}
    onclick={onTreeClick}
    onfocus={onTreeFocus}
  >
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
          {focusKey}
          {viewKey}
          cursorKey={treeCursorKey}
          {collapsedPaths}
          {snapshotKeys}
          {aggregateKeys}
          {aggregateSnapshotKeys}
          {tokenStats}
          siblingLabels={rootLabels}
          ontoggleexpand={handleToggleExpand}
          ontogglecollapse={handleToggleCollapse}
          onjump={handleJump}
          oncontextmenu={handleContextMenu}
        />
      {/each}
    </ul>
  </div>
</nav>

<style>
  /* Fills the resizable sidebar pane owned by App.svelte (which sets the width
     and hosts the drag handle), rather than hard-coding its own width. */
  .tree-sidebar {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 8px;
    box-sizing: border-box;
  }
  /* The scrolling region — only the node list moves; the header + actions above
     it are flex-shrink:0 and stay pinned. min-height:0 is the flexbox gotcha that
     lets this actually scroll instead of growing the whole column. */
  .tree-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .tree-scroll:focus {
    outline: none; /* the cursor row shows focus; no ring on the whole list… */
  }
  .tree-scroll:focus-visible {
    outline: 2px solid #4c9aff; /* …except for keyboard focus, which gets a ring */
    outline-offset: -2px;
    border-radius: 4px;
  }
  .tree-actions {
    display: flex;
    gap: 6px;
    padding: 4px 0 6px;
    flex-shrink: 0; /* pinned above the scrolling node list */
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
  .tree-follow {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.72rem;
    color: #cfcfcf;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
  }
  .tree-follow input {
    margin: 0;
    cursor: pointer;
  }
  .tree-follow-eye {
    font-size: 0.8rem;
    line-height: 1;
  }
  .tree-error {
    margin: 4px 8px;
    font-size: 11px;
    line-height: 1.35;
    color: #ff8a80;
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
    flex-shrink: 0; /* pinned above the scrolling node list */
  }
  .tree-level {
    list-style: none;
    margin: 0;
    padding-left: 14px;
  }
</style>
