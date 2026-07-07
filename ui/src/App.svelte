<script>
  import { onMount, tick } from "svelte";
  import { sectionedJustifiedLayout } from "./lib/layouts/sectionedJustified.js";
  import { visibleRange } from "./lib/layouts/windowing.js";
  import { detectBursts } from "./lib/bursts.js";
  import {
    buildDisplayEntries,
    entryDomId,
    resolvePhoto,
  } from "./lib/displayEntries.js";
  import {
    mergeFeedPage,
    deriveSectionHeaders,
    suppressPlaceholderHeaders,
    nearestRealItemId,
    formatGroupValue,
  } from "./lib/feed.js";
  import {
    fetchFeed,
    setRating as apiSetRating,
    setCover as apiSetCover,
    fetchMeta,
    fetchLibrary,
    scan as apiScan,
  } from "./lib/api.js";
  import Thumb, { PEEK_STEP_PX, MAX_PEEK_DEPTH } from "./lib/Thumb.svelte";
  import Loupe from "./lib/Loupe.svelte";
  import TreeSidebar from "./lib/TreeSidebar.svelte";
  import ManageLibrary from "./lib/ManageLibrary.svelte";
  import MultiAutoSelect from "multi-auto-select";

  const LS_KEY = "autogallery.lastDir";
  const LS_ZOOM = "autogallery.zoom";
  const LS_BURST_GAP = "autogallery.burstGapMs";
  const DEFAULT_BURST_GAP_MS = 3000;
  const DEFAULT_RATIO = 1.5; // placeholder until real dimensions arrive

  const hasNativePicker =
    typeof window !== "undefined" && !!window.autogallery?.pickFolder;

  // Zoom = target row height of the justified layout. +/- keys or the slider.
  const ZOOM_LEVELS = [120, 160, 220, 300, 400];
  const storedZoom = Number.parseInt(localStorage.getItem(LS_ZOOM) ?? "", 10);
  let zoom = // index into ZOOM_LEVELS ("|| default" would swallow level 0)
    Number.isInteger(storedZoom) &&
    storedZoom >= 0 &&
    storedZoom < ZOOM_LEVELS.length
      ? storedZoom
      : 2;
  $: localStorage.setItem(LS_ZOOM, String(zoom));
  $: rowHeight = ZOOM_LEVELS[zoom];

  const storedBurstGap = Number.parseInt(
    localStorage.getItem(LS_BURST_GAP) ?? "",
    10
  );
  let burstGapMs = Number.isFinite(storedBurstGap) && storedBurstGap >= 0
    ? storedBurstGap
    : DEFAULT_BURST_GAP_MS;
  $: localStorage.setItem(LS_BURST_GAP, String(burstGapMs));
  // Request thumbs at the size actually displayed (row height × device pixel
  // ratio), snapped to a few buckets so the disk cache isn't fragmented per
  // pixel. The server caps size at 1024.
  const THUMB_BUCKETS = [160, 320, 480, 640, 1024];
  $: thumbSize =
    THUMB_BUCKETS.find(
      (b) => b >= Math.ceil(rowHeight * (window.devicePixelRatio || 1))
    ) ?? 1024;

  /** Svelte action: mounts the real MultiAutoSelect DOM widget into the
   * node, keeps it in sync with `groupBy` via the `value` param, and
   * calls `onGroupByChange` when the user reorders/adds/removes a pill. */
  function groupBySelector(node, initialValue) {
    const widget = MultiAutoSelect(ALL_DIMENSIONS, {
      value: initialValue,
      placeholder: "Add a grouping level…",
      sortable: true,
    });
    widget.addEventListener("input", () => onGroupByChange(widget.value));
    node.appendChild(widget);
    return {
      destroy() {
        widget.remove();
      },
    };
  }

  let dir = localStorage.getItem(LS_KEY) || "";
  const LS_GROUP_BY = "autogallery.groupBy";
  const ALL_DIMENSIONS = ["folder", "year", "month", "day"];
  let groupBy = (() => {
    try {
      const stored = JSON.parse(localStorage.getItem(LS_GROUP_BY) ?? "null");
      if (Array.isArray(stored) && stored.every((d) => ALL_DIMENSIONS.includes(d))) {
        return stored;
      }
    } catch {
      /* fall through to default */
    }
    return ["folder"];
  })();
  $: localStorage.setItem(LS_GROUP_BY, JSON.stringify(groupBy));
  let collapsedPaths = []; // Array<Array<{dimension,value}>>, reset on hierarchy change
  let treeSidebarRef; // bound to TreeSidebar, for revealCurrentLocation to call revealPath
  let items = []; // the currently-loaded feed window, ordered
  let hasMoreBefore = false;
  let hasMoreAfter = true;
  let fetchingBefore = false;
  let fetchingAfter = false;
  const PAGE_SIZE = 60;
  const FETCH_THRESHOLD = 20; // start fetching more when within this many items of an edge
  let status = "";
  let error = "";
  let scanning = false;
  let feedEpoch = 0; // invalidates in-flight meta fetches when the window resets
  let library = [];
  let libraryOpen = false;
  let manageLibraryOpen = false;

  let selected = 0; // index into displayEntries; must never land on a
  // {kind:'placeholder'} entry — see nextSelectable below.
  let loupeOpen = false;
  let gridEl;
  let mainColumnEl;
  let gridWidth = 0;

  // Virtualization: only Thumbs in [renderStart, renderEnd] (plus the
  // selected index) are mounted. Recomputed on scroll/resize/layout change.
  let renderStart = 0;
  let renderEnd = -1;
  let rafPending = false;
  let focusPending = false; // set after a scan; consumed once `boxes` exists
  let expandedStackIds = new Set(); // stack ids currently expanded inline in the grid

  // Aggregate thumbnail load progress across the whole grid, fed by each
  // Thumb's attempt/settled events (Map mutations aren't reactive on their
  // own, hence thumbStatusTick as an explicit dependency). Reset per scan so
  // a rescan's ids don't inherit a stale previous scan's counts.
  let thumbStatus = new Map(); // id -> 'pending' | 'ok' | 'error'
  let thumbStatusTick = 0;
  function handleThumbAttempt(e) {
    thumbStatus.set(e.detail.id, "pending");
    thumbStatusTick++;
  }
  function handleThumbSettled(e) {
    thumbStatus.set(e.detail.id, e.detail.ok ? "ok" : "error");
    thumbStatusTick++;
  }
  $: thumbCounts = (() => {
    thumbStatusTick; // eslint-disable-line no-unused-expressions
    let pending = 0,
      ok = 0,
      error = 0;
    for (const s of thumbStatus.values()) {
      if (s === "pending") pending++;
      else if (s === "ok") ok++;
      else error++;
    }
    return { pending, ok, error };
  })();
  $: thumbProgress =
    thumbCounts.pending > 0
      ? `loading thumbnails… ${thumbCounts.ok} loaded${thumbCounts.error ? `, ${thumbCounts.error} failed` : ""}`
      : thumbCounts.error > 0
        ? `${thumbCounts.error} thumbnail${thumbCounts.error === 1 ? "" : "s"} failed to load`
        : "";

  onMount(() => {
    refreshLibrary();
    loadInitialFeed();
  });

  async function loadInitialFeed() {
    error = "";
    status = "loading…";
    thumbStatus = new Map();
    thumbStatusTick++;
    const epoch = ++feedEpoch;
    try {
      const { items: page } = await fetchFeed({
        groupBy,
        collapsed: collapsedPaths,
        after: PAGE_SIZE,
      });
      if (epoch !== feedEpoch) return;
      const merged = mergeFeedPage(
        { items: [], hasMoreBefore: false, hasMoreAfter: true },
        { items: page },
        "after",
        PAGE_SIZE
      );
      items = merged.items;
      hasMoreBefore = merged.hasMoreBefore;
      hasMoreAfter = merged.hasMoreAfter;
      // Matches the original doScan's reset — a fresh/reset feed load
      // always re-focuses the first item and closes any open loupe,
      // rather than leaving `selected` pointing at whatever index the
      // user had scrolled to in a now-discarded window. displayEntries is
      // a reactive statement over `items`, so it only reflects the
      // assignment above after the next microtask flush — await tick()
      // before reading it (see onGroupByChange for the same pattern).
      await tick();
      selected = nextSelectable(displayEntries, 0, 1) ?? 0;
      loupeOpen = false;
      focusPending = true;
      status = `${items.length} photo${items.length === 1 ? "" : "s"} loaded`;
      enrichMeta(page.map((i) => i.id));
    } catch (e) {
      error = e.message;
      status = "";
    }
  }

  /** Rebuild the feed for a new grouping order, re-centering on whatever
   * photo is currently selected so the user doesn't lose their place —
   * falls back to the start of the feed if nothing resolves. */
  async function onGroupByChange(newGroupBy) {
    groupBy = newGroupBy;
    collapsedPaths = [];
    const focusEntry = displayEntries[selected];
    const focusId = focusEntry ? resolvePhoto(focusEntry).id : null;
    error = "";
    status = "loading…";
    const epoch = ++feedEpoch;
    try {
      const { items: beforePage } = focusId
        ? await fetchFeed({ groupBy, focusId, before: PAGE_SIZE / 2, after: 0 })
        : { items: [] };
      const { items: afterPage, focusItem } = await fetchFeed({
        groupBy,
        focusId,
        before: 0,
        after: focusId ? PAGE_SIZE / 2 : PAGE_SIZE,
      });
      if (epoch !== feedEpoch) return;
      const combined = focusId
        ? [...beforePage, ...(focusItem ? [focusItem] : []), ...afterPage]
        : afterPage;
      items = combined;
      hasMoreBefore = focusId ? beforePage.length >= PAGE_SIZE / 2 : false;
      hasMoreAfter = afterPage.length >= (focusId ? PAGE_SIZE / 2 : PAGE_SIZE);
      // `selected` indexes displayEntries (the burst-stack-collapsed view),
      // not raw items — beforePage.length would drift as soon as any burst
      // among the "before" items collapses into a single display entry.
      // displayEntries is a reactive statement over `items`, so it only
      // reflects the assignment above after the next microtask flush.
      await tick();
      const focusIndex = focusId
        ? displayEntries.findIndex((e) => resolvePhoto(e).id === focusId)
        : -1;
      // No nextSelectable() needed here: fetchFeed above is never called
      // with a `collapsed` list (it defaults to `[]` in both api.js and the
      // server), so this window can never contain a placeholder entry —
      // findIndex above always lands on a real photo/stack or -1.
      selected = focusIndex !== -1 ? focusIndex : 0;
      focusPending = true;
      status = `${items.length} photo${items.length === 1 ? "" : "s"} loaded`;
      enrichMeta(items.map((i) => i.id));
    } catch (e) {
      error = e.message;
      status = "";
    }
  }

  /** Jump the feed to an arbitrary hierarchy path from the tree — unlike
   * onGroupByChange's re-centering, there's no specific photo id to seek
   * from (the target section may never have been loaded), so this uses
   * getFeedPage's startPath seek instead of a focusId. */
  async function jumpToPath(path) {
    error = "";
    status = "loading…";
    const epoch = ++feedEpoch;
    try {
      const { items: page } = await fetchFeed({
        groupBy,
        collapsed: collapsedPaths,
        startPath: path,
        after: PAGE_SIZE,
      });
      if (epoch !== feedEpoch) return;
      const merged = mergeFeedPage(
        { items: [], hasMoreBefore: false, hasMoreAfter: true },
        { items: page },
        "after",
        PAGE_SIZE
      );
      items = merged.items;
      hasMoreBefore = merged.hasMoreBefore;
      hasMoreAfter = merged.hasMoreAfter;
      // See loadInitialFeed: displayEntries needs a tick to reflect the
      // `items` assignment above before it can be used to pick `selected`.
      await tick();
      selected = nextSelectable(displayEntries, 0, 1) ?? 0;
      loupeOpen = false;
      focusPending = true;
      status = `${items.length} photo${items.length === 1 ? "" : "s"} loaded`;
      enrichMeta(page.map((i) => i.id));
    } catch (e) {
      error = e.message;
      status = "";
    }
  }

  /** "Reveal current location": walks the tree down to whatever photo is
   * currently selected, expanding/fetching each level as needed. Manual,
   * not continuous — doesn't fight the tree's own navigation while the
   * user is mid-scroll or has it open to a different part of the library. */
  async function revealCurrentLocation() {
    const entry = displayEntries[selected];
    if (!entry || entry.kind === "placeholder") return;
    const photo = resolvePhoto(entry);
    if (!photo?.groupValues) return;
    const path = groupBy
      .filter((d) => photo.groupValues[d] !== undefined)
      .map((d) => ({ dimension: d, value: photo.groupValues[d] }));
    treeSidebarRef?.revealPath(path);
  }

  function pathKey(path) {
    return path.map((p) => `${p.dimension}=${p.value}`).join(">");
  }

  /** Toggle whether the section identified by `path` (an ordered prefix of
   * `groupBy`) is collapsed. Collapsing removes its photos from `items`
   * (they were fetched already) and refetches — a subsequent scroll won't
   * re-request them, since the server excludes the collapsed path. */
  async function toggleSectionCollapse(path) {
    const key = pathKey(path);
    const already = collapsedPaths.some((p) => pathKey(p) === key);
    collapsedPaths = already
      ? collapsedPaths.filter((p) => pathKey(p) !== key)
      : [...collapsedPaths, path];
    await loadInitialFeed();
  }

  /** Scroll so this section's header lands at its stuck (sticky) position
   * at the top of the scroll container — accounting for any shallower
   * headers stacked above it, matching the CSS `top` offset used for
   * depth stacking. */
  function scrollToSection(pos) {
    if (!gridEl || !mainColumnEl) return;
    const gridTop = gridEl.getBoundingClientRect().top + mainColumnEl.scrollTop;
    const target = gridTop + pos.y - pos.depth * HEADER_HEIGHT + PAD;
    mainColumnEl.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }

  async function loadMore(direction) {
    if (direction === "after") {
      if (fetchingAfter || !hasMoreAfter || !items.length) return;
      fetchingAfter = true;
    } else {
      if (fetchingBefore || !hasMoreBefore || !items.length) return;
      fetchingBefore = true;
    }
    const epoch = feedEpoch;
    const focusId =
      direction === "after"
        ? nearestRealItemId(items, "end")
        : nearestRealItemId(items, "start");
    if (focusId == null) {
      // Every currently-loaded item is a placeholder (e.g. everything
      // visible right now is collapsed) — nothing real to seek from yet.
      if (direction === "after") fetchingAfter = false;
      else fetchingBefore = false;
      return;
    }
    // Preserve scroll position when prepending: content inserted above
    // the fold shifts everything below it down by the same amount, so
    // without this the browser's fixed scrollTop would visually jump
    // (the user would suddenly be looking at different content).
    const gridHeightBefore = gridEl ? gridEl.getBoundingClientRect().height : 0;
    try {
      const { items: page } = await fetchFeed({
        groupBy,
        collapsed: collapsedPaths,
        focusId,
        before: direction === "before" ? PAGE_SIZE : 0,
        after: direction === "after" ? PAGE_SIZE : 0,
      });
      if (epoch !== feedEpoch) return;
      const merged = mergeFeedPage(
        { items, hasMoreBefore, hasMoreAfter },
        { items: page },
        direction,
        PAGE_SIZE
      );
      items = merged.items;
      hasMoreBefore = merged.hasMoreBefore;
      hasMoreAfter = merged.hasMoreAfter;
      enrichMeta(page.map((i) => i.id));
      if (direction === "before" && page.length) {
        await tick();
        const gridHeightAfter = gridEl
          ? gridEl.getBoundingClientRect().height
          : 0;
        mainColumnEl.scrollBy(0, gridHeightAfter - gridHeightBefore);
      }
    } catch (e) {
      error = e.message;
    } finally {
      if (direction === "after") fetchingAfter = false;
      else fetchingBefore = false;
    }
  }

  // Progressively fetch dimensions for a batch of newly-loaded ids; the
  // justified layout refines itself as each batch lands (grid appears
  // immediately with placeholders). Unlike the old per-folder-scan
  // version, a feed page is already a bounded batch (PAGE_SIZE), so no
  // further chunking is needed here.
  async function enrichMeta(ids) {
    const epoch = feedEpoch;
    const need = ids.filter((id) => {
      const it = items.find((i) => i.id === id);
      return it && it.width == null;
    });
    if (!need.length) return;
    try {
      const metas = await fetchMeta(need);
      if (epoch !== feedEpoch) return;
      for (const m of metas) {
        const it = items.find((i) => i.id === m.id);
        if (!it) continue;
        // Record the attempt's outcome unconditionally, even when no usable
        // dimensions came back (RAW: server returns width/height 0) — the
        // "already attempted" check below is `it.width == null`, so leaving
        // width/height unset here would re-request metadata for this photo
        // forever. takenAt is set independently since a RAW file can still
        // have a valid capture date from EXIF despite unavailable dimensions.
        it.width = m.width ?? 0;
        it.height = m.height ?? 0;
        it.takenAt = m.takenAt;
      }
      items = items; // re-layout with real aspect ratios
    } catch {
      return; // metadata is an enhancement; the grid still works without it
    }
  }

  async function refreshLibrary() {
    library = await fetchLibrary().catch(() => library);
  }

  async function onFolderRemoved() {
    await refreshLibrary();
    loadInitialFeed();
  }

  async function doScan() {
    if (!dir.trim()) return;
    error = "";
    scanning = true;
    status = "scanning…";
    try {
      await apiScan(dir.trim());
      localStorage.setItem(LS_KEY, dir.trim());
      refreshLibrary();
      // The scanned folder is now indexed — reload the feed from the
      // start so the newly-scanned photos appear (they may sort anywhere
      // in the current grouping, not necessarily at the loaded window's
      // edge, so a full reset is simpler and correct here).
      await loadInitialFeed();
    } catch (e) {
      error = e.message;
      status = "";
    } finally {
      scanning = false;
    }
  }

  function selectFromLibrary(entry) {
    libraryOpen = false;
    if (!entry.mounted) {
      // Offline folders can still be browsed read-only from the SQLite
      // cache (the app's offline-mirror invariant) — reuse the same
      // jumpToPath the tree sidebar already uses for any folder, rather
      // than requiring a live rescan this folder's volume can't provide.
      jumpToPath([{ dimension: "folder", value: entry.path }]);
      return;
    }
    dir = entry.path;
    doScan();
  }

  async function chooseFolder() {
    const path = await window.autogallery?.pickFolder();
    if (path) {
      dir = path;
      doScan();
    }
  }

  // Flickr-style justified layout via the pure module in lib/layouts/ —
  // aspect ratios in, positioned boxes out. Absolutely-positioned children
  // ignore CSS padding, so the frame inset is applied to the box coordinates.
  const PAD = 12;
  const HEADER_HEIGHT = 32;
  const PLACEHOLDER_HEIGHT = 40; // a bit taller than a header — needs room for an icon, label, and count on one line

  /**
   * Symmetric horizontal margin (px, at the target row height) reserved for
   * a collapsed stack's peek layers, so they're visible within the tile's
   * own box rather than relying entirely on the inter-tile gap. Fixed at
   * MAX_PEEK_DEPTH * PEEK_STEP_PX regardless of the stack's actual size —
   * peek layers beyond that depth render at the same clamped offset (see
   * Thumb.svelte), so every stack's footprint stays small and neat, never
   * growing for a very large burst. 0 for a non-stack entry or a stack
   * with no peeks (a 1-member "stack" can't happen per detectBursts'
   * minimum-cluster-size-2 rule, but guard anyway for clarity).
   */
  function stackMarginPx(entry) {
    return entry.kind === "stack" && entry.peekItems.length > 0
      ? MAX_PEEK_DEPTH * PEEK_STEP_PX
      : 0;
  }

  $: stacks = detectBursts(items, { gapMs: burstGapMs });
  $: displayEntries = buildDisplayEntries(items, stacks, expandedStackIds);
  $: resolvedPhotos = displayEntries.map(resolvePhoto); // passed to Loupe
  // deriveSectionHeaders' `index` must land in the same index space as the
  // `{#each visibleItems}` loop below, which walks `displayEntries` (via
  // buildVisibleItems) — not raw `items`. A collapsed burst stack folds
  // several `items` rows into a single display entry, so indexing against
  // `items` directly would drift out of sync with every entry downstream of
  // any collapsed stack. `resolvedPhotos` is already displayEntries' 1:1
  // photo-per-entry projection (see the Loupe usage above), so it's the
  // correct input here.
  $: sectionHeaders = suppressPlaceholderHeaders(
    deriveSectionHeaders(resolvedPhotos, groupBy),
    displayEntries
  );
  $: layoutResult =
    displayEntries.length && gridWidth > 2 * PAD
      ? sectionedJustifiedLayout(
          displayEntries.map((e) => {
            if (e.kind === "placeholder") {
              return { id: entryDomId(e), placeholder: true };
            }
            const photo = resolvePhoto(e);
            const baseRatio =
              photo.width && photo.height
                ? photo.width / photo.height
                : DEFAULT_RATIO;
            // Reserve extra width for a collapsed stack's peek layers (see
            // stackMarginPx) by inflating its aspect ratio at the target
            // row height — an approximation, not pixel-exact once a row's
            // uniform scale factor is applied, but close enough for a
            // cosmetic margin.
            const marginPx = stackMarginPx(e);
            return {
              id: entryDomId(e),
              aspectRatio: baseRatio + (2 * marginPx) / rowHeight,
            };
          }),
          sectionHeaders,
          {
            containerWidth: gridWidth - 2 * PAD,
            gap: 8,
            targetRowHeight: rowHeight,
            headerHeight: HEADER_HEIGHT,
            placeholderHeight: PLACEHOLDER_HEIGHT,
          }
        )
      : null;
  $: boxes = layoutResult ? layoutResult.boxes : null;
  $: gridHeight = layoutResult ? layoutResult.totalHeight + 2 * PAD : 0;
  // The first time this fires (right when `boxes` first becomes non-null,
  // e.g. after the initial feed load), the grid's layout/paint may not have
  // settled yet, so gridEl.getBoundingClientRect() below can return
  // stale/incomplete geometry and produce a too-small initial render window
  // that nothing else ever corrects. Recompute immediately (no regression
  // when layout was already settled — zoom change, meta enrichment, rescan),
  // then again after tick() + requestAnimationFrame, once the DOM has
  // actually finished laying out (tick() alone only guarantees pending
  // state changes were applied to the DOM, not that the browser finished a
  // layout/paint pass) — see focusPending above for the same class of issue.
  $: if (boxes) {
    updateVisibleRange();
    tick().then(() => requestAnimationFrame(updateVisibleRange));
  }
  $: visibleItems = buildVisibleItems(displayEntries, renderStart, renderEnd, selected);

  // First scan of a session: bind:clientWidth's initial value arrives
  // asynchronously (Svelte's iframe resize-listener fires on iframe.onload),
  // so `boxes` may still be null right after doScan sets focusPending. Defer
  // the post-scan focus until `boxes` — and therefore the selected Thumb —
  // actually exists; this also covers rescans, where `boxes` is already
  // truthy and this fires immediately.
  $: if (focusPending && boxes) {
    focusPending = false;
    tick().then(() => {
      // Thumb's data-id attribute is always the resolved photo's raw id
      // (Thumb only ever receives `item`, never the display entry), so DOM
      // lookups must key on resolvePhoto(entry).id, not entryDomId(entry) —
      // entryDomId is the stack id for a collapsed stack and never appears
      // in the DOM as a data-id.
      const entry = displayEntries[selected];
      gridEl?.querySelector(`[data-id="${entry ? resolvePhoto(entry).id : ""}"]`)?.focus();
    });
  }

  function rate(index, rating) {
    const entry = displayEntries[index];
    if (!entry) return;
    const it = resolvePhoto(entry);
    if (!it) return;
    it.rating = rating;
    items = items; // trigger reactivity
    apiSetRating(it.id, rating).catch((e) => (error = e.message));
  }

  /**
   * Toggle the manual cover choice for the given display entry: if it's
   * already the stack's manual pick, clear it (revert to automatic
   * selection); otherwise make it the pick, clearing any other member of
   * the same stack that was previously manually chosen. At most one
   * manual pick per stack is enforced here, in the UI — pickCover's own
   * fallback (first-in-cluster-order) only matters if that invariant is
   * ever violated some other way.
   */
  function toggleCover(entry) {
    if (entry?.kind !== "photo" || !entry.stackId) return;
    const stack = stacks.find((s) => s.id === entry.stackId);
    if (!stack) return;

    const target = entry.item;
    const makingManual = !target.preferredCover;

    for (const id of stack.memberIds) {
      const it = items.find((i) => i.id === id);
      if (!it) continue;
      const shouldBeCover = makingManual && id === target.id;
      if (it.preferredCover !== shouldBeCover) {
        it.preferredCover = shouldBeCover;
        apiSetCover(it.id, shouldBeCover).catch((e) => (error = e.message));
      }
    }
    items = items; // trigger reactivity
  }

  function openLoupe(index) {
    selected = index;
    loupeOpen = true;
  }

  async function closeLoupe() {
    loupeOpen = false;
    await tick();
    // Return focus to the grid, scrolled to the current item. (Key on
    // resolvePhoto(entry).id, matching Thumb's data-id — see focusPending.)
    const entry = displayEntries[selected];
    gridEl?.querySelector(`[data-id="${entry ? resolvePhoto(entry).id : ""}"]`)?.focus();
  }

  /** Re-collapse a stack: remove it from expandedStackIds, then re-select
   * and re-focus its now-collapsed tile once displayEntries recomputes. */
  async function collapseStack(stackId) {
    expandedStackIds.delete(stackId);
    expandedStackIds = expandedStackIds; // trigger reactivity
    await tick();
    const newIndex = displayEntries.findIndex(
      (e) => e.kind === "stack" && e.stack.id === stackId
    );
    if (newIndex !== -1) {
      selected = newIndex;
      await tick();
      // The re-collapsed tile resolves to its cover photo, so its data-id
      // is the cover's raw id, not stackId — see focusPending's comment.
      const entry = displayEntries[newIndex];
      gridEl
        ?.querySelector(`[data-id="${resolvePhoto(entry).id}"]`)
        ?.focus({ preventScroll: true });
    }
  }

  /** Expand a stack: every member appears individually, tagged with the
   * stack id, until collapseStack() is called (Escape, in onKeydown). */
  async function toggleExpand(stack) {
    if (expandedStackIds.has(stack.id)) {
      await collapseStack(stack.id);
      return;
    }
    expandedStackIds.add(stack.id);
    expandedStackIds = expandedStackIds; // trigger reactivity
    await tick();
    const newIndex = displayEntries.findIndex(
      (e) => e.kind === "photo" && e.item.id === stack.coverId
    );
    if (newIndex !== -1) {
      selected = newIndex;
      await tick();
      gridEl
        ?.querySelector(`[data-id="${stack.coverId}"]`)
        ?.focus({ preventScroll: true });
    }
  }

  /** Recompute [renderStart, renderEnd] from the grid's current position,
   * and trigger a fetch-more in either direction when the render window
   * is near a loaded edge. */
  function updateVisibleRange() {
    if (!gridEl || !boxes) {
      renderStart = 0;
      renderEnd = -1;
      return;
    }
    const rect = gridEl.getBoundingClientRect();
    const range = visibleRange(boxes, {
      scrollTop: -rect.top,
      viewportHeight: mainColumnEl.clientHeight,
    });
    renderStart = range.start;
    renderEnd = range.end;

    if (renderEnd >= displayEntries.length - FETCH_THRESHOLD) {
      loadMore("after");
    }
    if (renderStart <= FETCH_THRESHOLD) {
      loadMore("before");
    }
  }

  /** Collapse a burst of scroll/resize events to one recompute per frame. */
  function scheduleVisibleRangeUpdate() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      updateVisibleRange();
    });
  }

  /**
   * Indices to mount: the virtualized window, plus `selected` so keyboard
   * jumps (Home/End, arrow past the window) mount their target and Thumb's
   * own scrollIntoView reactive block (Thumb.svelte:42) brings it into view.
   */
  function buildVisibleItems(entries, start, end, selected) {
    const indices = [];
    for (let i = start; i <= end; i++) indices.push(i);
    if (selected < entries.length && !indices.includes(selected)) {
      const insertAt = indices.findIndex((i) => i > selected);
      if (insertAt === -1) indices.push(selected);
      else indices.splice(insertAt, 0, selected);
    }
    return indices.map((i) => ({ i, entry: entries[i] }));
  }

  /** Placeholders (in-place folded rows for a collapsed section) are never a
   * valid keyboard-selection target, matching how section headers already
   * aren't part of the selectable index space. Steps from `from` in `dir`
   * (+1/-1) until landing on a non-placeholder entry, or returns null if
   * the entries run out in that direction first. */
  function nextSelectable(entries, from, dir) {
    let i = from;
    while (i >= 0 && i < entries.length && entries[i]?.kind === "placeholder") {
      i += dir;
    }
    if (i < 0 || i >= entries.length) return null;
    return i;
  }

  /** Nearest box in the row adjacent (in direction `dir`) to `fromIndex`'s
   * row, by horizontal centre — the geometric core of navVertical, factored
   * out so navVertical can re-run it from an intermediate (placeholder)
   * landing spot without reading `selected` from the closure. Returns null
   * when `fromIndex` is already on the first/last row. */
  function nearestBoxInAdjacentRow(fromIndex, dir) {
    const cur = boxes[fromIndex];
    if (!cur) return null;
    const curCx = cur.x + cur.width / 2;
    // Find the y coordinate of the adjacent row.
    let rowY = null;
    for (let i = 0; i < boxes.length; i++) {
      const t = boxes[i].y;
      if (dir > 0 ? t > cur.y : t < cur.y) {
        if (
          rowY === null ||
          (dir > 0 ? t < rowY : t > rowY) // nearest row in that direction
        )
          rowY = t;
      }
    }
    if (rowY === null) return null; // already on the first/last row
    // Nearest horizontal centre within that row.
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].y !== rowY) continue;
      const d = Math.abs(boxes[i].x + boxes[i].width / 2 - curCx);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * Vertical navigation in a justified layout: rows have varying column
   * counts, so move to the box in the adjacent row whose horizontal centre is
   * nearest to the current one. If that lands on a placeholder, keep
   * advancing row by row (placeholders are never a valid selection target)
   * until a real entry is found or there's no further row, in which case the
   * original selection is kept.
   * @param {1|-1} dir
   */
  function navVertical(dir) {
    if (!boxes) return selected;
    const start = selected;
    let cur = start;
    while (true) {
      const next = nearestBoxInAdjacentRow(cur, dir);
      if (next === null) return start; // no further row that direction
      if (displayEntries[next]?.kind !== "placeholder") return next;
      cur = next; // placeholder row — keep looking past it
    }
  }

  async function onKeydown(e) {
    // Never steal keystrokes from a focused input (e.g. typing a folder path
    // with digits in it must not rate photos).
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable)
      return;
    if (e.metaKey || e.ctrlKey || e.altKey) return; // browser shortcuts

    if (!displayEntries.length) return;
    const key = e.key;

    // Grid zoom: +/- steps through the justified row heights.
    if (!loupeOpen && (key === "+" || key === "=" || key === "-")) {
      e.preventDefault();
      zoom = Math.max(
        0,
        Math.min(ZOOM_LEVELS.length - 1, zoom + (key === "-" ? -1 : 1))
      );
      return;
    }

    // Star rating: 1-5 set stars, 0 clears. Works in both grid and loupe.
    if (/^[0-5]$/.test(key)) {
      e.preventDefault();
      rate(selected, Number(key));
      // Auto-advance, but never onto a placeholder (see nextSelectable).
      if (loupeOpen) {
        const t = nextSelectable(displayEntries, selected + 1, 1);
        if (t !== null) selected = t;
      }
      return;
    }

    // Manual cover choice: 'C' toggles whether the selected photo is its
    // stack's manually-chosen cover. Only meaningful for a member of a
    // currently expanded stack; a no-op otherwise. Works in both grid and
    // loupe, since both share the same selected index into displayEntries.
    if (key.toLowerCase() === "c") {
      const entry = displayEntries[selected];
      if (entry?.stackId) {
        e.preventDefault();
        toggleCover(entry);
      }
      return;
    }

    if (loupeOpen) {
      if (key === "Escape") {
        e.preventDefault();
        closeLoupe();
      } else if (key === "ArrowRight" || key === "ArrowDown") {
        e.preventDefault();
        // Placeholders are never a valid selection target (see
        // nextSelectable) — skip past one rather than opening it in Loupe.
        const t = nextSelectable(displayEntries, selected + 1, 1);
        if (t !== null) selected = t;
      } else if (key === "ArrowLeft" || key === "ArrowUp") {
        e.preventDefault();
        const t = nextSelectable(displayEntries, selected - 1, -1);
        if (t !== null) selected = t;
      }
      return;
    }

    // Escape in the grid: collapse an expanded stack if the selection is
    // currently inside one.
    if (key === "Escape") {
      const entry = displayEntries[selected];
      if (entry?.stackId) {
        e.preventDefault();
        await collapseStack(entry.stackId);
      }
      return;
    }

    // Grid navigation. Placeholders (in-place folded rows for a collapsed
    // section) are never a valid selection target — every branch below
    // resolves to the nearest non-placeholder entry in the direction of
    // travel, falling back to `selected` (no movement) if none exists.
    let next = selected;
    if (key === "ArrowRight")
      next = nextSelectable(displayEntries, selected + 1, 1) ?? selected;
    else if (key === "ArrowLeft")
      next = nextSelectable(displayEntries, selected - 1, -1) ?? selected;
    else if (key === "ArrowDown") next = navVertical(1);
    else if (key === "ArrowUp") next = navVertical(-1);
    else if (key === "Enter" || key === " ") {
      e.preventDefault();
      const entry = displayEntries[selected];
      if (entry?.kind === "stack") {
        toggleExpand(entry.stack);
      } else {
        openLoupe(selected);
      }
      return;
    } else if (key === "Home")
      next = nextSelectable(displayEntries, 0, 1) ?? selected;
    else if (key === "End")
      next =
        nextSelectable(displayEntries, displayEntries.length - 1, -1) ??
        selected;
    else return;

    e.preventDefault();
    selected = next;
    await tick();
    const entry = displayEntries[selected];
    gridEl
      ?.querySelector(`[data-id="${entry ? resolvePhoto(entry).id : ""}"]`)
      ?.focus({ preventScroll: true });
  }
</script>

<svelte:window on:keydown={onKeydown} on:resize={scheduleVisibleRangeUpdate} />

<div class="app">
  <header class="topbar">
    <h1>AutoGallery</h1>
    <div class="group-by" use:groupBySelector={groupBy}></div>
    <button
      class="reveal-btn"
      on:click={revealCurrentLocation}
      title="Reveal the current photo's location in the tree"
    >
      Locate
    </button>
    <input
      class="dir"
      type="text"
      placeholder="/path/to/photos"
      bind:value={dir}
      on:keydown={(e) => e.key === "Enter" && doScan()}
      spellcheck="false"
    />
    <button class="scan" on:click={doScan} disabled={scanning}>
      {scanning ? "Scanning…" : "Scan"}
    </button>
    {#if hasNativePicker}
      <button class="choose-folder" on:click={chooseFolder} disabled={scanning}>
        Choose Folder…
      </button>
    {/if}
    <div class="library">
      <button
        class="library-toggle"
        on:click={() => (libraryOpen = !libraryOpen)}
        title="Recently scanned folders"
      >
        Library ▾
      </button>
      {#if libraryOpen}
        <ul class="library-panel">
          {#if library.length === 0}
            <li class="library-empty">No folders scanned yet.</li>
          {/if}
          {#each library as entry (entry.path)}
            <li>
              <button
                class="library-entry"
                class:offline={!entry.mounted}
                on:click={() => selectFromLibrary(entry)}
                title={entry.path}
              >
                {entry.name}
                {#if !entry.mounted}<span class="offline-badge">offline</span>{/if}
              </button>
            </li>
          {/each}
          <li>
            <button
              class="library-entry"
              on:click={() => {
                libraryOpen = false;
                manageLibraryOpen = true;
              }}
            >
              Manage library…
            </button>
          </li>
        </ul>
      {/if}
    </div>
    {#if manageLibraryOpen}
      <ManageLibrary
        {library}
        on:close={() => (manageLibraryOpen = false)}
        on:folderRemoved={onFolderRemoved}
      />
    {/if}
    <label class="zoom" title="Grid zoom (also + / - keys)">
      <span class="zoom-icon small">▦</span>
      <input
        type="range"
        min="0"
        max={ZOOM_LEVELS.length - 1}
        step="1"
        bind:value={zoom}
      />
      <span class="zoom-icon">▦</span>
    </label>
    <label
      class="burst-gap"
      title="Group photos taken within this many seconds as a burst"
    >
      <span class="burst-gap-icon">⧉</span>
      <input type="range" min="0" max="10000" step="500" bind:value={burstGapMs} />
      <span class="burst-gap-value">{(burstGapMs / 1000).toFixed(1)}s</span>
    </label>
    <span class="status" class:err={!!error}>{error || status}</span>
    {#if thumbProgress}
      <span class="thumb-progress" class:err={thumbCounts.error > 0}>
        {thumbProgress}
      </span>
    {/if}
  </header>

  <div class="app-body">
    <TreeSidebar
      bind:this={treeSidebarRef}
      {groupBy}
      {collapsedPaths}
      on:toggle={(e) => toggleSectionCollapse(e.detail)}
      on:jump={(e) => jumpToPath(e.detail)}
    />
    <div
      class="main-column"
      bind:this={mainColumnEl}
      on:scroll={scheduleVisibleRangeUpdate}
    >
      {#if items.length}
        <div
          class="grid"
          bind:this={gridEl}
          bind:clientWidth={gridWidth}
          style={boxes ? `height:${gridHeight}px;` : ""}
          role="listbox"
          tabindex="-1"
        >
          {#if boxes}
            <!-- Headers render unconditionally for the whole loaded window, unlike
                 photos — there are only dozens/hundreds of them (vs. tens of
                 thousands of photos), so they don't need windowing, and a header
                 whose triggering index falls outside the virtualized photo range
                 must still survive (it may be sticky-stuck mid-section while the
                 viewer has scrolled well past its origin index). -->
            {#each layoutResult.headers as header (header.dimension + header.value + header.index)}
              <div
                class="section-wrapper"
                style="top:{header.y}px; height:{header.endY - header.y}px;"
              >
                <div
                  class="section-header"
                  style="top:{header.depth * HEADER_HEIGHT}px; z-index:{15 - header.depth};"
                >
                  <button
                    class="section-toggle-icon"
                    title="Collapse/expand this section"
                    on:click={() =>
                      toggleSectionCollapse(
                        groupBy.slice(0, header.depth + 1).map((d) => ({
                          dimension: d,
                          value: resolvedPhotos[header.index]?.groupValues[d],
                        }))
                      )}
                  >
                    ▾
                  </button>
                  <button
                    class="section-label"
                    on:click={() => scrollToSection(header)}
                  >
                    {header.label}
                  </button>
                </div>
              </div>
            {/each}
            {#each visibleItems as { i, entry } (entryDomId(entry))}
              {#if entry.kind === "placeholder"}
                <div
                  class="placeholder-row"
                  style="top:{boxes[i].y}px; height:{boxes[i].height}px;"
                  role="button"
                  tabindex="0"
                  on:click={() => toggleSectionCollapse(entry.item.path)}
                  on:keydown={(e) =>
                    e.key === "Enter" && toggleSectionCollapse(entry.item.path)}
                >
                  <span class="placeholder-icon">▸</span>
                  <span class="placeholder-label">
                    {entry.item.path
                      .map((p) => formatGroupValue(p.dimension, p.value))
                      .join(" / ")}
                  </span>
                  <span class="placeholder-count">
                    {entry.item.count.toLocaleString()} items
                  </span>
                </div>
              {:else}
                <Thumb
                  item={resolvePhoto(entry)}
                  box={boxes[i]}
                  pad={PAD}
                  size={thumbSize}
                  selected={i === selected}
                  stackCount={entry.kind === "stack" ? entry.stack.count : undefined}
                  stackPeekItems={entry.kind === "stack" ? entry.peekItems : []}
                  stackMarginPx={stackMarginPx(entry)}
                  inExpandedStack={entry.kind === "photo" && entry.stackId !== null}
                  isCurrentCover={entry.kind === "photo" &&
                    entry.stackId !== null &&
                    stacks.find((s) => s.id === entry.stackId)?.coverId === entry.item.id}
                  on:click={() =>
                    entry.kind === "stack" ? toggleExpand(entry.stack) : openLoupe(i)}
                  on:attempt={handleThumbAttempt}
                  on:settled={handleThumbSettled}
                />
              {/if}
            {/each}
          {/if}
        </div>
      {:else if !scanning && status !== "loading…"}
        <div class="empty">Nothing indexed yet — scan a folder to get started.</div>
      {/if}
    </div>
  </div>
</div>

{#if loupeOpen}
  <Loupe items={resolvedPhotos} bind:index={selected} />
{/if}

<style>
  :global(body) {
    margin: 0;
    background: #141414;
    color: #e8e8e8;
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
  }
  .app {
    /* Exact (not min-) height: .app-body's flex:1 and .main-column's
       overflow-y:auto only create an internal scroll region if this
       ancestor has a bounded height instead of growing to fit content —
       otherwise the whole page would scroll again, defeating the point
       of moving the scroll container off `window`. */
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .app-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .main-column {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
  }
  .reveal-btn {
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    color: inherit;
    font: inherit;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
  }
  .reveal-btn:hover {
    background: #2a2a2a;
  }
  .topbar {
    position: sticky;
    top: 0;
    /* Must outrank the grid content scrolling underneath it. Thumb.svelte's
       `.thumb` sets an explicit z-index:10 (its own stacking context,
       needed for the selection border/peek layers to paint correctly) —
       that value projects into this same ancestor stacking context as a
       sibling-level number. At a tie, later DOM order wins the paint, and
       the grid comes after .topbar in the document, so equal z-index let
       thumbnails render over this sticky bar while scrolling. 20 clears
       that comfortably while staying below Loupe.svelte's full-screen
       overlay (z-index:100), which still needs to cover the topbar. */
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 1rem;
    background: #1c1c1c;
    border-bottom: 1px solid #2a2a2a;
  }
  h1 {
    font-size: 1rem;
    font-weight: 600;
    margin: 0;
    color: #fff;
    white-space: nowrap;
  }
  .dir {
    flex: 1;
    max-width: 40rem;
    padding: 0.45rem 0.6rem;
    background: #101010;
    border: 1px solid #333;
    border-radius: 6px;
    color: #eee;
    font-size: 0.9rem;
    font-family: ui-monospace, monospace;
  }
  .dir:focus {
    outline: none;
    border-color: #4c9aff;
  }
  .scan {
    padding: 0.45rem 1rem;
    background: #4c9aff;
    color: #06121f;
    border: none;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
  }
  .scan:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .choose-folder {
    padding: 0.45rem 1rem;
    background: #4c9aff;
    color: #06121f;
    border: none;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
  }
  .choose-folder:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .library {
    position: relative;
  }
  .library-toggle {
    padding: 0.45rem 1rem;
    background: #4c9aff;
    color: #06121f;
    border: none;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
  }
  .library-toggle:hover {
    background: #5ba8ff;
  }
  .library-panel {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 200;
    margin: 4px 0 0;
    padding: 4px 0;
    min-width: 220px;
    max-height: 300px;
    overflow-y: auto;
    list-style: none;
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 4px;
  }
  .library-entry {
    display: block;
    width: 100%;
    padding: 6px 10px;
    text-align: left;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
  }
  .library-entry:hover:not(:disabled) {
    background: #2a2a2a;
  }
  .library-entry.offline {
    color: #888;
    cursor: default;
  }
  .offline-badge {
    margin-left: 6px;
    font-size: 0.7rem;
    color: #888;
  }
  .library-empty {
    padding: 6px 10px;
    color: #888;
  }
  .zoom {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #777;
  }
  .zoom input[type="range"] {
    width: 90px;
    accent-color: #4c9aff;
  }
  .zoom-icon {
    font-size: 1rem;
    line-height: 1;
  }
  .zoom-icon.small {
    font-size: 0.7rem;
  }
  .burst-gap {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #777;
  }
  .burst-gap input[type="range"] {
    width: 90px;
    accent-color: #4c9aff;
  }
  .burst-gap-icon {
    font-size: 1rem;
    line-height: 1;
  }
  .burst-gap-value {
    font-size: 0.75rem;
    min-width: 2.5em;
  }
  .status {
    color: #9a9a9a;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .status.err {
    color: #ff6b6b;
  }
  .thumb-progress {
    color: #9a9a9a;
    font-size: 0.8rem;
    white-space: nowrap;
  }
  .thumb-progress.err {
    color: #ff8a80;
  }
  .grid {
    /* Justified layout: children are absolutely positioned by computed boxes;
       height is set inline from the layout result. */
    position: relative;
    width: 100%;
  }
  .grid:focus {
    outline: none;
  }
  .section-wrapper {
    position: absolute;
    left: 0;
    width: 100%;
    pointer-events: none;
  }
  .section-header {
    position: sticky;
    z-index: 15;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: #141414;
    pointer-events: auto;
  }
  .section-toggle-icon {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
  }
  .section-toggle-icon:hover {
    background: #2a2a2a;
  }
  .section-label {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    text-align: left;
  }
  .section-label:hover {
    background: #2a2a2a;
  }
  .placeholder-row {
    position: absolute;
    left: 0;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    box-sizing: border-box;
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    cursor: pointer;
    color: inherit;
    font: inherit;
    text-align: left;
  }
  .placeholder-row:hover {
    background: #2a2a2a;
  }
  .placeholder-count {
    margin-left: auto;
    color: #888;
    font-size: 0.85em;
  }
  .empty {
    padding: 4rem 1rem;
    text-align: center;
    color: #777;
  }
  .group-by :global(.multi-auto-select) {
    color: inherit;
  }
  .group-by :global(.pill) {
    background: #2a2a2a !important;
    color: #eee !important;
    border-color: #444 !important;
  }
</style>
