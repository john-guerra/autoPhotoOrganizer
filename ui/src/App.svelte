<script>
  import { onMount, tick } from "svelte";
  import { sectionedJustifiedLayout } from "./lib/layouts/sectionedJustified.js";
  import { visibleRange } from "./lib/layouts/windowing.js";
  import { detectBurstsByGroup } from "./lib/bursts.js";
  import {
    nextSelectable,
    navVertical,
    findEntryIndexForId,
    resolveSelectedIndex,
  } from "./lib/navigation.js";
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
    computeHeaderPaths,
    pathKey,
    headerParentPaths,
  } from "./lib/feed.js";
  import {
    fetchFeed,
    fetchGroupBoundary,
    fetchTreeNode,
    setRating as apiSetRating,
    setCover as apiSetCover,
    fetchMeta,
    fetchLibrary,
    scan as apiScan,
    startScan,
    startExport,
    fetchPhotoIds,
    fetchPhotoCount,
    fetchAlbumTimeline,
    setScope,
    removeFolderByPath,
  } from "./lib/api.js";
  import { waitForJob } from "./lib/jobs.js";
  import Thumb, { PEEK_STEP_PX, MAX_PEEK_DEPTH } from "./lib/Thumb.svelte";
  import Loupe from "./lib/Loupe.svelte";
  import JobsPanel from "./lib/JobsPanel.svelte";
  import TreeSidebar from "./lib/TreeSidebar.svelte";
  import FisheyeSidebar from "./lib/FisheyeSidebar.svelte";
  import ManageLibrary from "./lib/ManageLibrary.svelte";
  import AlbumsView from "./lib/AlbumsView.svelte";
  import SnapshotStrip from "./lib/SnapshotStrip.svelte";
  import RatingFilter from "./lib/RatingFilter.svelte";
  import OrientationFilter from "./lib/OrientationFilter.svelte";
  import {
    DEFAULT_FILTER,
    isActive as filterIsActive,
  } from "./lib/filterSpec.js";
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

  const LS_BURST_ENABLED = "autogallery.burstEnabled";
  let burstEnabled = localStorage.getItem(LS_BURST_ENABLED) !== "false"; // default on
  $: localStorage.setItem(LS_BURST_ENABLED, String(burstEnabled));
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
  // Recursive "soup folder" scan: pull in every subfolder. Default on — the
  // common case is pointing at a parent of dated album folders.
  const LS_RECURSIVE = "autogallery.recursiveScan";
  let recursiveScan = localStorage.getItem(LS_RECURSIVE) !== "false";
  $: localStorage.setItem(LS_RECURSIVE, String(recursiveScan));
  const LS_GROUP_BY = "autogallery.groupBy";
  const ALL_DIMENSIONS = ["folder", "year", "month", "day", "camera", "kind"];
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

  // Global feed sort (attribute + direction). Threaded into every feed/tree/
  // boundary call; date sorts re-derive the year/month/day grouping (server-side
  // applySortToDims), so grouping and sorting agree on one date notion.
  const LS_SORT = "autogallery.sort";
  const SORT_ATTRS = [
    "date_taken",
    "date_created",
    "date_modified",
    "rating",
    "size",
    "name",
  ];
  const SORT_LABELS = {
    date_taken: "Taken",
    date_created: "Created",
    date_modified: "Modified",
    rating: "Rating",
    size: "Size",
    name: "Name",
  };
  let sort = (() => {
    try {
      const s = JSON.parse(localStorage.getItem(LS_SORT) ?? "null");
      if (s && SORT_ATTRS.includes(s.by) && (s.dir === "asc" || s.dir === "desc"))
        return s;
    } catch {
      /* fall through to default */
    }
    return { by: "date_taken", dir: "desc" };
  })();
  $: localStorage.setItem(LS_SORT, JSON.stringify(sort));

  const LS_FILTER = "autogallery.filter";
  let filter = (() => {
    try {
      const stored = JSON.parse(localStorage.getItem(LS_FILTER) ?? "null");
      if (stored && typeof stored === "object") return { ...DEFAULT_FILTER, ...stored };
    } catch {
      /* fall through to default */
    }
    return { ...DEFAULT_FILTER };
  })();
  $: localStorage.setItem(LS_FILTER, JSON.stringify(filter));

  // --- Selection (multi-select for batch export) --------------------------
  // A persistent Set of photo ids the user has picked. Culling a trip is a
  // long, expensive process, so the selection survives reloads/quits via
  // localStorage (like `filter` above). Ids are stable DB row ids, valid
  // across rescans of the same folder; ids that later vanish (folder removed)
  // are simply skipped by export server-side, so no pruning is needed here.
  const LS_SELECTION = "autogallery.selection";
  let selectedIds = new Set(
    (() => {
      try {
        const stored = JSON.parse(localStorage.getItem(LS_SELECTION) ?? "null");
        if (Array.isArray(stored))
          return stored.filter((n) => Number.isInteger(n));
      } catch {
        /* fall through to empty */
      }
      return [];
    })()
  );
  $: localStorage.setItem(LS_SELECTION, JSON.stringify([...selectedIds]));
  // Stash of the last cleared selection, so Clear is undoable (persists until
  // used or the next clear replaces it — no timed toast, per project taste).
  let lastClearedSelection = null;

  // "Keep only" working set: when non-null, an explicit id list that the feed,
  // counts, sidebars, albums and export all scope to, while the counts still
  // report the true library total. null = whole library.
  let keepIds = null;

  // Auto-albums review mode: replaces the grid with a time-gap-clustered view
  // of the working set (see AlbumsView).
  let albumMode = false;
  let albumPhotos = [];
  let albumTruncated = false;
  let detectingAlbums = false;
  // Max photos pulled into the album timeline (user-tunable; server hard-caps).
  let albumLimit =
    Number(localStorage.getItem("autogallery.albumLimit")) || 20000;

  // Filter mode: does the rating/orientation filter narrow what's DISPLAYED
  // (classic), or drive the SELECTION (the grid then shows everything and the
  // matching photos join the selection)? A persisted toggle.
  const LS_FILTER_MODE = "autogallery.filterMode";
  let filterMode =
    localStorage.getItem(LS_FILTER_MODE) === "select" ? "select" : "display";
  $: localStorage.setItem(LS_FILTER_MODE, filterMode);
  // What the feed/tree/counts actually filter by. In "select" mode the grid
  // is deliberately NOT narrowed — the filter only feeds the selection — so
  // the display filter is the no-op default.
  $: displayFilter = {
    ...(filterMode === "select" ? DEFAULT_FILTER : filter),
    // keep-only ids live server-side in the keep_scope table (POSTed by
    // applyKeepOnly); the filter carries only a flag, so the scope is unbounded.
    ...(keepIds ? { keepScope: true } : {}),
  };

  // Three live counts the user asked for: whole library, currently shown
  // (under displayFilter), and selected. selectedCount is reactive off the Set.
  let libraryTotal = 0;
  let showingCount = 0;
  $: selectedCount = selectedIds.size;

  // Export popover state (mirrors the add-folder popover).
  const LS_EXPORT_DEST = "autogallery.exportDest";
  let exportOpen = false;
  let exportDest = localStorage.getItem(LS_EXPORT_DEST) || "";
  let exportName = defaultExportName();
  let exporting = false;
  let exportResult = null;

  // Sidebar view: classic "tree" or focus+context "fisheye" (toggle, persisted).
  const LS_SIDEBAR_MODE = "autogallery.sidebarMode";
  let sidebarMode =
    localStorage.getItem(LS_SIDEBAR_MODE) === "fisheye" ? "fisheye" : "tree";
  $: localStorage.setItem(LS_SIDEBAR_MODE, sidebarMode);
  let collapsedPaths = []; // Array<Array<{dimension,value}>>, reset on hierarchy change
  // Groups rendered as a one-line SnapshotStrip instead of the collapsed
  // pill. A group in this set is ALSO server-collapsed (its path lives in
  // collapsedPaths, per the tri-state design in
  // docs/superpowers/specs/2026-07-09-fisheye-snapshot-view-design.md) —
  // this set only decides how the client renders that collapsed placeholder.
  // Keyed by pathKey(path), reset on hierarchy change alongside collapsedPaths.
  let snapshotGroupKeys = new Set();
  const SNAPSHOT_ROW_HEIGHT = 148; // group label row on top + the strip beneath
  // Last global view action (the top-of-toolbar "cycle all" control); the
  // per-group toggles may diverge from it, but the button just applies the
  // next whole-view state each click: full view → snapshot all → collapse all.
  let globalViewMode = "expanded"; // "expanded" | "snapshot" | "collapsed"
  let cyclingAll = false;
  // Two-click confirm for "remove album from library" (drops the folder's rows
  // + ratings from the index; files on disk are untouched). Holds the pathKey
  // of the group armed for removal; the next click on the same group commits.
  let removeArmedKey = null;
  let treeSidebarRef; // bound to TreeSidebar, for revealCurrentLocation to call revealPath
  let items = []; // the currently-loaded feed window, ordered
  let hasMoreBefore = false;
  let hasMoreAfter = true;
  let fetchingBefore = false;
  let fetchingAfter = false;
  // Guards jumpGroupBoundary's *entire* duration, including the initial
  // fetchGroupBoundary lookup — unlike fetchingBefore/fetchingAfter (which
  // it also sets, but only after that lookup resolves), nothing previously
  // stopped a second Option+Left/Right from starting a fully independent
  // jump while an earlier one was still awaiting its own boundary lookup.
  // Two overlapping jumps' network calls can resolve out of order (the
  // second-pressed jump's boundary lookup can simply finish first), and
  // since each jump replaces `items` wholesale, the epoch guard only
  // protects against a stale jump's page landing *after* a newer one's own
  // `items` replacement — it doesn't stop a scroll/loadMore triggered by
  // the first jump's own boxes-recompute from merging a page seeked from
  // its (by-then-superseded) window onto whatever the second jump just
  // replaced `items` with. Confirmed live: firing several Option+Right
  // presses in quick succession produced a section header for the same
  // folder appearing twice, with a different folder's photos sandwiched in
  // between — a non-contiguous `items` array, not a genuine duplicate row
  // (the database has no duplicate photos/folders). A simple re-entry
  // guard, checked and set before the first await, closes this off.
  let jumpingGroup = false;
  // True from a group-jump's landing until its window's metadata finishes
  // loading — the cue to re-assert the landing once (the above-the-fold rows
  // resize as their dimensions arrive, drifting the one-shot landing down).
  // Cleared the instant the user takes over (a keypress or wheel/trackpad
  // scroll), so the re-assert never fights them. Not a timer.
  let jumpRevealPending = false;
  // Per-group photo counts shown on each section header, so the user knows
  // how many photos a group holds before scrolling it (the loaded window is
  // only a slice; a group can hold thousands). Keyed by pathKey(group path).
  // A count depends ONLY on that path's constraints (WHERE folder=… AND
  // year=…), never on groupBy order or the loaded window, so the cache is
  // valid for the whole session and is only reset when a rescan can change
  // the underlying photos (loadInitialFeed bumps countsEpoch). headerCounts
  // is reassigned (not mutated) to stay reactive; the two Sets are plain
  // bookkeeping and needn't be.
  let headerCounts = {}; // pathKey(fullPath) -> number
  let fetchedParents = new Set(); // pathKey(parentPath) already resolved
  let inFlightParents = new Set(); // pathKey(parentPath) mid-fetch (dedup)
  let countsEpoch = 0;
  const PAGE_SIZE = 60;
  const FETCH_THRESHOLD = 20; // start fetching more when within this many items of an edge
  let status = "";
  let error = "";
  let scanning = false;
  let feedEpoch = 0; // invalidates in-flight meta fetches when the window resets
  let library = [];
  // Bumped whenever the library's photo set changes (scan, folder removal,
  // full reset). The sidebars key their refetch on this so they always mirror
  // the real index, not just groupBy/filter changes.
  let libraryVersion = 0;
  let libraryOpen = false;
  let addFolderOpen = false;
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
    refreshCounts();
  });

  async function loadInitialFeed() {
    error = "";
    status = "loading…";
    thumbStatus = new Map();
    thumbStatusTick++;
    // A rescan can add/remove photos, changing group counts — invalidate the
    // header-count cache so it refetches (bumping the epoch also discards any
    // count fetch still in flight from the previous window).
    countsEpoch++;
    headerCounts = {};
    fetchedParents = new Set();
    inFlightParents = new Set();
    const epoch = ++feedEpoch;
    // Block loadMore (scroll-triggered) from firing while this operation
    // replaces the whole `items` window — otherwise a concurrent loadMore
    // started against the OLD window can resolve after this one finishes
    // and splice its (now-stale) page into the NEW items, producing
    // duplicate rows and duplicate Svelte keys (`{#each}` then throws and
    // the grid stops updating, which reads as the UI "freezing").
    fetchingBefore = true;
    fetchingAfter = true;
    try {
      const { items: page } = await fetchFeed({
        groupBy,
        collapsed: collapsedPaths,
        after: PAGE_SIZE,
        filter: displayFilter,
        sort,
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
    } finally {
      fetchingBefore = false;
      fetchingAfter = false;
    }
  }

  /** Rebuild the feed for a new grouping order, re-centering on whatever
   * photo is currently selected so the user doesn't lose their place —
   * falls back to the start of the feed if nothing resolves. */
  async function onGroupByChange(newGroupBy) {
    groupBy = newGroupBy;
    collapsedPaths = [];
    snapshotGroupKeys = new Set();
    await recenterFeedOnId(safeFocusId(selected));
  }

  /** Change the global feed sort, then rebuild the feed centered on the current
   * selection via onGroupByChange's guarded loader (same reuse as filter changes
   * — see the "no 7th copy" rule). Sidebars react to the `sort` prop on their own. */
  function onSortChange(next) {
    if (next.by === sort.by && next.dir === sort.dir) return;
    sort = next;
    onGroupByChange(groupBy);
  }

  /** Apply a new filter spec. In "display" mode this narrows the grid: the
   * header-count cache is now stale (same paths, different counts), so
   * invalidate it, then rebuild the feed centered on the current selection via
   * onGroupByChange's existing guarded loader (reused deliberately rather than
   * duplicating its fetchingBefore/After/feedEpoch guard — see CLAUDE.md's "no
   * 7th copy" rule). In "select" mode the grid is NOT narrowed (displayFilter
   * stays default), so the feed is untouched — instead the matching photos are
   * unioned into the selection. */
  function onFilterChange(next) {
    filter = next;
    if (filterMode === "select") {
      // The grid already shows everything; just grow the selection to match.
      if (filterIsActive(next)) selectMatching(next);
      refreshCounts();
      return;
    }
    countsEpoch++;
    headerCounts = {};
    fetchedParents = new Set();
    inFlightParents = new Set();
    onGroupByChange(groupBy);
    refreshCounts();
  }

  /** Toggle the Display/Select filter mode. Switching flips displayFilter, so
   * the feed content changes (narrowed ⇄ full) — rebuild it like a filter
   * change. Entering select mode with an active filter immediately selects the
   * matches, so "flip to Select" turns the current filter into a selection. */
  function onFilterModeChange(mode) {
    if (mode === filterMode) return;
    filterMode = mode;
    countsEpoch++;
    headerCounts = {};
    fetchedParents = new Set();
    inFlightParents = new Set();
    onGroupByChange(groupBy);
    refreshCounts();
    if (mode === "select" && filterIsActive(filter)) selectMatching(filter);
  }

  /** Union every photo matching `spec` into the selection (never removes — so
   * lowering a star threshold or manual picks accumulate rather than fight). */
  async function selectMatching(spec) {
    try {
      const ids = await fetchPhotoIds(filterIsActive(spec) ? spec : null);
      selectedIds = new Set([...selectedIds, ...ids]);
    } catch (e) {
      error = e.message;
    }
  }

  /** Select every photo in one section/group (respecting the display filter),
   * unioning them into the selection. Powers the per-group "Select" action. */
  async function selectGroup(path) {
    if (!path || !path.length) return;
    try {
      const ids = await fetchPhotoIds(
        filterIsActive(displayFilter) ? displayFilter : null,
        path
      );
      selectedIds = new Set([...selectedIds, ...ids]);
    } catch (e) {
      error = e.message;
    }
  }

  /** Remove an album (folder group) from the library index — a two-click
   * confirm because it drops the folder's photo rows AND their ratings from
   * SQLite (files on disk are untouched; a rescan re-adds the photos, unrated).
   * Only meaningful for a folder group; the button is gated on a folder leaf. */
  async function removeAlbum(path) {
    const folderPath = path?.find((p) => p.dimension === "folder")?.value;
    if (!folderPath) return;
    const key = pathKey(path);
    if (removeArmedKey !== key) {
      removeArmedKey = key; // first click arms the confirm
      return;
    }
    removeArmedKey = null;
    try {
      await removeFolderByPath(folderPath);
      collapsedPaths = collapsedPaths.filter((p) => pathKey(p) !== key);
      snapshotGroupKeys.delete(key);
      snapshotGroupKeys = snapshotGroupKeys;
      await loadInitialFeed();
    } catch (e) {
      error = e.message;
    }
  }

  /** Enter/replace "keep only" focus on an explicit id set. The set is stored
   * server-side (keep_scope table via setScope) and referenced by displayFilter's
   * keepScope flag, so it can be any size; the library total keeps showing the
   * real count. Passing null (or an empty set) leaves keep-only. */
  async function applyKeepOnly(ids) {
    const next = ids && ids.length ? [...ids] : null;
    try {
      // Push the scope to the server BEFORE any feed/tree/count query reads it.
      await setScope(next ?? []);
    } catch (e) {
      error = e.message;
      return;
    }
    keepIds = next;
    countsEpoch++;
    headerCounts = {};
    fetchedParents = new Set();
    inFlightParents = new Set();
    onGroupByChange(groupBy);
    refreshCounts();
  }

  /** Keep only the current selection as the working set. */
  function keepOnlySelection() {
    if (selectedIds.size === 0) return;
    applyKeepOnly([...selectedIds]);
  }

  /** Keep only one group/section (all its photos) as the working set. */
  async function keepOnlyGroup(path) {
    if (!path || !path.length) return;
    try {
      const ids = await fetchPhotoIds(null, path);
      if (!ids.length) return;
      applyKeepOnly(ids);
    } catch (e) {
      error = e.message;
    }
  }

  /** Leave keep-only focus, back to the whole library. */
  function exitKeepOnly() {
    applyKeepOnly(null);
  }

  /** Toggle one photo's membership in the selection. */
  function toggleSelect(id) {
    if (typeof id !== "number") return;
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    selectedIds = selectedIds; // reassign to trigger reactivity
  }

  /** Add every real photo between two displayEntries indices (inclusive) to
   * the selection — the shift-click range. Collapsed-stack entries contribute
   * their cover photo only. */
  function selectRange(a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let k = lo; k <= hi; k++) {
      const p = resolvedPhotos[k];
      if (p && typeof p.id === "number") selectedIds.add(p.id);
    }
    selectedIds = selectedIds;
  }

  /** Grid tile click: Cmd/Ctrl toggles selection, Shift selects a range from
   * the focused tile, a plain click keeps the existing open/expand behavior. */
  function onTileClick(e, entry, i) {
    if (e.metaKey || e.ctrlKey) {
      toggleSelect(resolvePhoto(entry)?.id);
      return;
    }
    if (e.shiftKey) {
      selectRange(selected, i);
      return;
    }
    if (entry.kind === "stack") toggleExpand(entry.stack);
    else openLoupe(i);
  }

  /** Clear the whole selection — guarded (it can represent a lot of work) and
   * undoable until the next clear replaces the stash. */
  function clearSelection() {
    if (selectedIds.size === 0) return;
    const n = selectedIds.size;
    if (
      !confirm(`Clear all ${n} selected photo${n === 1 ? "" : "s"}? (undoable)`)
    )
      return;
    lastClearedSelection = new Set(selectedIds);
    selectedIds = new Set();
  }

  function undoClearSelection() {
    if (!lastClearedSelection) return;
    selectedIds = new Set([...selectedIds, ...lastClearedSelection]);
    lastClearedSelection = null;
  }

  /** Refresh the library-total and showing counts (cheap COUNT queries). */
  async function refreshCounts() {
    try {
      libraryTotal = await fetchPhotoCount(null);
      showingCount = filterIsActive(displayFilter)
        ? await fetchPhotoCount(displayFilter)
        : libraryTotal;
    } catch {
      /* leave last-known counts on a transient error */
    }
  }

  function defaultExportName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_selected`;
  }

  /** Copy the selected photos into a new folder on disk (server copies, never
   * moves — originals are the read-only source of truth). Runs as a
   * cancelable background job; live progress shows in the JobsPanel, this
   * just waits for the terminal result to update the local UI. */
  async function doExport() {
    if (selectedIds.size === 0) return;
    if (!exportDest.trim() || !exportName.trim()) {
      error = "Choose a destination folder and a name.";
      return;
    }
    exporting = true;
    exportResult = null;
    error = "";
    try {
      const { jobId } = await startExport({
        photoIds: [...selectedIds],
        destParent: exportDest.trim(),
        folderName: exportName.trim(),
      });
      localStorage.setItem(LS_EXPORT_DEST, exportDest.trim());
      const job = await waitForJob(jobId);
      if (job.status === "done") {
        const res = job.result;
        exportResult = res;
        status = `Exported ${res.copied} photo${res.copied === 1 ? "" : "s"}${
          res.skipped ? `, ${res.skipped} skipped` : ""
        } → ${res.target}`;
      } else if (job.status === "canceled") {
        status = "Export canceled";
      } else {
        error = job.error || "Export failed";
      }
    } catch (e) {
      error = e.message;
    } finally {
      exporting = false;
    }
  }

  /** Electron-only native picker for the export destination parent folder. */
  async function chooseExportDest() {
    const path = await window.autogallery?.pickFolder();
    if (path) exportDest = path;
  }

  /** Auto-albums: pull the current working set as a time-ordered timeline and
   * hand it to AlbumsView, which clusters it by gap client-side (instant slider
   * re-clustering). Respects displayFilter — including a "Keep only" scope — so
   * you can narrow first, then detect. */
  async function detectAlbums() {
    detectingAlbums = true;
    error = "";
    try {
      const resp = await fetchAlbumTimeline(
        filterIsActive(displayFilter) ? displayFilter : null,
        albumLimit
      );
      albumPhotos = resp.photos;
      albumTruncated = resp.truncated;
      // Reflect the server-clamped cap (e.g. a 99999 request comes back 20000).
      if (resp.limit) {
        albumLimit = resp.limit;
        localStorage.setItem("autogallery.albumLimit", String(albumLimit));
      }
      albumMode = true;
    } catch (e) {
      error = e.message;
    } finally {
      detectingAlbums = false;
    }
  }

  /** AlbumsView asked for a different max — persist it and re-pull the timeline
   * (staying in album mode; detectAlbums keeps albumMode true). */
  async function onAlbumRelimit(newLimit) {
    albumLimit = Math.max(1, Math.round(Number(newLimit) || 0));
    localStorage.setItem("autogallery.albumLimit", String(albumLimit));
    await detectAlbums();
  }

  /** After a full library reset (from the Manage Library danger zone): the
   * index and every rating are gone, so clear the selection and reload. */
  async function onLibraryReset() {
    manageLibraryOpen = false;
    selectedIds = new Set();
    lastClearedSelection = null;
    keepIds = null;
    await refreshLibrary();
    await loadInitialFeed();
    refreshCounts();
    libraryVersion++;
  }

  /** Jump the feed to an arbitrary hierarchy path from the tree — unlike
   * onGroupByChange's re-centering, there's no specific photo id to seek
   * from (the target section may never have been loaded), so this uses
   * getFeedPage's startPath seek instead of a focusId. */
  async function jumpToPath(path) {
    error = "";
    status = "loading…";
    const epoch = ++feedEpoch;
    // See loadInitialFeed's comment: blocks a concurrent scroll-triggered
    // loadMore from splicing a stale page into the window this replaces.
    fetchingBefore = true;
    fetchingAfter = true;
    try {
      const { items: page } = await fetchFeed({
        groupBy,
        collapsed: collapsedPaths,
        startPath: path,
        after: PAGE_SIZE,
        filter: displayFilter,
        sort,
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
    } finally {
      fetchingBefore = false;
      fetchingAfter = false;
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

  /** The group path of the first photo currently visible in the feed — drives
   * the fisheye sidebar's "you are here" marker so it follows the feed as you
   * scroll. Read-only: derived from the existing render window, it never
   * scrolls the feed itself (honours issue #40's no-scroll-hijack rule). */
  function deriveCurrentPath(start, entries, gb) {
    for (let i = Math.max(0, start); i < entries.length; i++) {
      const e = entries[i];
      if (!e || e.kind === "placeholder") continue;
      const gv = resolvePhoto(e)?.groupValues;
      if (!gv) continue;
      return gb
        .filter((d) => gv[d] !== undefined)
        .map((d) => ({ dimension: d, value: gv[d] }));
    }
    return null;
  }
  $: currentPath = deriveCurrentPath(renderStart, displayEntries, groupBy);

  /** Keeps the first occurrence of each id, dropping later repeats. Guards
   * against a real, observed case: fetching "before" and "after" a focusId
   * as two independent seeks (used when re-centering on a known photo —
   * toggleSectionCollapse, onGroupByChange) can return overlapping rows
   * once a collapsed-path exclusion is active, producing duplicate ids in
   * the raw concatenation — which Svelte's keyed {#each} then throws on,
   * stopping the grid from updating further (reads as the UI "freezing").
   * loadInitialFeed/jumpToPath don't need this: they merge into an
   * existing window via mergeFeedPage, which already dedupes by id. */
  function dedupeById(arr) {
    const seen = new Set();
    return arr.filter((it) => {
      if (seen.has(it.id)) return false;
      seen.add(it.id);
      return true;
    });
  }

  /** A placeholder entry (any collapsed section, however it got there) has
   * no real photo id — resolvePhoto(entry).id would be its synthetic
   * "collapsed:..." key, which the server can't seek on (it turns into
   * NaN once coerced to a number) — so anything that turns `selected` into
   * a server focusId must route through this, not read
   * displayEntries[selected] directly. `excludePath`, when given, ALSO
   * treats entries inside that specific group path as unusable — for
   * collapsing a section the selection is itself inside, about to be
   * hidden (the server never lets a focusId fall inside a collapsed path,
   * see server/db/feed.js's keyPassesSeek). Walks forward then backward
   * from `fromIndex` for the nearest usable entry if the one at
   * `fromIndex` itself doesn't qualify. */
  function safeFocusEntry(fromIndex, excludePath = null) {
    const insidePath = (entry) => {
      if (!entry || !excludePath) return false;
      const values = resolvePhoto(entry).groupValues;
      return excludePath.every((p) => values?.[p.dimension] === p.value);
    };
    const usable = (entry) =>
      entry && entry.kind !== "placeholder" && !insidePath(entry);
    const direct = displayEntries[fromIndex];
    if (usable(direct)) return direct;
    return (
      displayEntries.slice(fromIndex).find(usable) ??
      [...displayEntries.slice(0, fromIndex)].reverse().find(usable) ??
      null
    );
  }

  function safeFocusId(fromIndex, excludePath = null) {
    const entry = safeFocusEntry(fromIndex, excludePath);
    return entry ? resolvePhoto(entry).id : null;
  }

  /** THE canonical focusId-centered feed replace (issue #42). Fetches a
   * half-page before+after `focusId` under the current collapsed paths,
   * dedupes the two seeks, replaces `items`, and re-anchors `selected` on
   * that photo. Guarded by feedEpoch + fetchingBefore/After. Returns the
   * resolved `selected` index, or -1 if the epoch was superseded/errored.
   * onGroupByChange and toggleSectionCollapse both route through this. */
  async function recenterFeedOnId(focusId, { collapsed = collapsedPaths } = {}) {
    error = "";
    status = "loading…";
    const epoch = ++feedEpoch;
    // See loadInitialFeed's comment: blocks a concurrent scroll-triggered
    // loadMore from splicing a stale page into the window this replaces.
    fetchingBefore = true;
    fetchingAfter = true;
    try {
      const { items: beforePage } = focusId
        ? await fetchFeed({
            groupBy,
            collapsed,
            focusId,
            before: PAGE_SIZE / 2,
            after: 0,
            filter: displayFilter,
            sort,
          })
        : { items: [] };
      const { items: afterPage, focusItem } = await fetchFeed({
        groupBy,
        collapsed,
        focusId,
        before: 0,
        after: focusId ? PAGE_SIZE / 2 : PAGE_SIZE,
        filter: displayFilter,
        sort,
      });
      if (epoch !== feedEpoch) return -1;
      items = focusId
        ? dedupeById([...beforePage, ...(focusItem ? [focusItem] : []), ...afterPage])
        : afterPage;
      hasMoreBefore = focusId ? beforePage.length >= PAGE_SIZE / 2 : false;
      hasMoreAfter = afterPage.length >= (focusId ? PAGE_SIZE / 2 : PAGE_SIZE);
      await tick();
      selected = resolveSelectedIndex(displayEntries, focusId);
      focusPending = true;
      status = `${items.length} photo${items.length === 1 ? "" : "s"} loaded`;
      enrichMeta(items.map((i) => i.id));
      return selected;
    } catch (e) {
      error = e.message;
      status = "";
      return -1;
    } finally {
      fetchingBefore = false;
      fetchingAfter = false;
    }
  }

  /** Toggle a section's collapsed state and re-center the feed on whatever
   * photo is currently selected, so the user doesn't lose their place —
   * mirrors onGroupByChange's re-centering. */
  async function toggleSectionCollapse(path) {
    const key = pathKey(path);
    const collapsing = !collapsedPaths.some((p) => pathKey(p) === key);
    collapsedPaths = collapsing
      ? [...collapsedPaths, path]
      : collapsedPaths.filter((p) => pathKey(p) !== key);
    await recenterFeedOnId(safeFocusId(selected, collapsing ? path : null));
  }

  /** Feed group tri-state: expanded → snapshot → collapsed → expanded.
   * snapshot is a server-collapsed group the client renders as a strip. */
  async function cycleGroupState(path) {
    const key = pathKey(path);
    const isCollapsed = collapsedPaths.some((p) => pathKey(p) === key);
    const isSnapshot = snapshotGroupKeys.has(key);
    if (!isCollapsed) {
      snapshotGroupKeys.add(key);
      snapshotGroupKeys = snapshotGroupKeys; // reassign → reactivity
      await toggleSectionCollapse(path); // server-collapse
    } else if (isSnapshot) {
      snapshotGroupKeys.delete(key);
      snapshotGroupKeys = snapshotGroupKeys; // snapshot → pill, no refetch
    } else {
      await toggleSectionCollapse(path); // server-expand
    }
  }

  /** The top-of-toolbar "cycle all" control: flip EVERY top-level group at
   * once through full view → snapshot all → collapse all → full view. Fetches
   * the current top-level group list from the tree, then sets collapsedPaths /
   * snapshotGroupKeys wholesale and rebuilds the feed from the top. */
  async function cycleAllGroups() {
    if (cyclingAll) return;
    const next =
      globalViewMode === "expanded"
        ? "snapshot"
        : globalViewMode === "snapshot"
          ? "collapsed"
          : "expanded";
    cyclingAll = true;
    try {
      if (next === "expanded") {
        collapsedPaths = [];
        snapshotGroupKeys = new Set();
      } else {
        const { nodes } = await fetchTreeNode({
          groupBy,
          path: [],
          filter: displayFilter,
          sort,
        });
        const allPaths = nodes.map((n) => [
          { dimension: groupBy[0], value: n.value },
        ]);
        collapsedPaths = allPaths;
        snapshotGroupKeys =
          next === "snapshot" ? new Set(allPaths.map(pathKey)) : new Set();
      }
      globalViewMode = next;
      await loadInitialFeed();
    } catch (e) {
      error = e.message;
    } finally {
      cyclingAll = false;
    }
  }

  /** Bring the selected tile into view using the native scroll API — called
   * ONLY from active navigation (keyboard, group-jump). One-shot and
   * imperative: it never re-fires on reflow, so it can't hijack the user's
   * scrolling. The tile's CSS `scroll-margin-top` (var --reveal-margin) keeps
   * it clear of the sticky-header band.
   * `block: "start"` (group-jump) puts the landing at the top of the group;
   * `"nearest"` (keyboard nav) scrolls the minimum and is a no-op when the tile
   * is already fully visible.
   * @param {{block?: ScrollLogicalPosition}} [opts]
   */
  function revealSelected({ block = "nearest" } = {}) {
    const entry = displayEntries[selected];
    const id = entry ? resolvePhoto(entry).id : null;
    const tile = id != null && gridEl?.querySelector(`[data-id="${id}"]`);
    tile?.scrollIntoView({ block, inline: "nearest" });
  }

  /** Hold a group-jump's landing at revealMargin below the viewport top until
   * the user takes over. Two reflows fight the landing after a jump, and a
   * single one-shot reveal survives neither: (1) at jump time the after-page
   * tiles aren't mounted yet, so the document is too short and the reveal maxes
   * out below the target; (2) as the rows ABOVE the landing get their real
   * (usually shorter) dimensions, the target slides up and off the top — the
   * grid is absolutely positioned, so the browser's native scroll-anchoring
   * can't hold it. Driven by the `boxes` reactive (scheduleJumpPin), which
   * fires on every layout recompute — including height-neutral ones a
   * ResizeObserver would miss — until jumpRevealPending is cleared on the
   * user's first keypress/wheel. loadMore("before") is suppressed while pinned
   * (see updateVisibleRange) so a prepend never fights this. */
  function pinNow() {
    if (!mainColumnEl || !gridEl) return;
    const entry = displayEntries[selected];
    const id = entry ? resolvePhoto(entry).id : null;
    const tile = id != null && gridEl.querySelector(`[data-id="${id}"]`);
    if (!tile) return;
    const t = tile.getBoundingClientRect();
    const c = mainColumnEl.getBoundingClientRect();
    // getBoundingClientRect forces a synchronous layout, so this reads the
    // tile's REAL current position even mid-reflow (where box.y can lag).
    const delta = t.top - c.top - revealMargin;
    if (Math.abs(delta) > 0.5) {
      const max = mainColumnEl.scrollHeight - mainColumnEl.clientHeight;
      mainColumnEl.scrollTop = Math.max(
        0,
        Math.min(max, mainColumnEl.scrollTop + delta)
      );
    }
  }

  /** Re-pin after a layout recompute (the `boxes` reactive). tick() waits for
   * Svelte to patch the DOM so pinNow reads the tile's post-reflow position;
   * re-check the flag, which may have cleared (user took over) during the tick. */
  function scheduleJumpPin() {
    tick().then(() => {
      if (jumpRevealPending) pinNow();
    });
  }

  /** Give roving keyboard focus to the currently-selected tile's DOM element,
   * without letting the browser's native focus-scroll fight revealSelected
   * (preventScroll). Shared by keyboard nav and group-jump. */
  function focusSelectedTile() {
    const entry = displayEntries[selected];
    gridEl
      ?.querySelector(`[data-id="${entry ? resolvePhoto(entry).id : ""}"]`)
      ?.focus({ preventScroll: true });
  }

  /** Scroll so this section's header lands at its stuck (sticky) position
   * at the top of the scroll container — accounting for any shallower
   * headers stacked above it, matching the CSS `top` offset used for
   * depth stacking. Returns a promise that resolves once the (smooth,
   * animated) scroll has genuinely settled — a defensive extension of
   * loadMore's concurrency guard through the whole animation, not just
   * the synchronous scrollTo() call, for callers that just replaced the
   * whole feed window (the real fix for the cascade this class of bug
   * caused live is in loadMore itself — see its own comment — but there's
   * no reason to leave a second, related gap open here too). Falls back
   * to a bounded timeout in case scrollend never fires (e.g. the target
   * already matches the current position, or some interruption) so this
   * can never leave the guard stuck permanently. */
  function scrollToSection(pos) {
    if (!gridEl || !mainColumnEl) return Promise.resolve();
    const gridTop = gridEl.getBoundingClientRect().top + mainColumnEl.scrollTop;
    const target = Math.max(0, gridTop + pos.y - pos.depth * HEADER_HEIGHT + PAD);
    if (Math.abs(mainColumnEl.scrollTop - target) < 1) return Promise.resolve();
    mainColumnEl.scrollTo({ top: target, behavior: "smooth" });
    return new Promise((resolve) => {
      const done = () => {
        mainColumnEl.removeEventListener("scrollend", done);
        resolve();
      };
      mainColumnEl.addEventListener("scrollend", done, { once: true });
      setTimeout(done, 1000);
    });
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
    // `selected` is a raw index into displayEntries. Prepending a "before"
    // page shifts every existing entry's index forward by however many new
    // entries land in front of it — capture the CURRENTLY selected photo's
    // id now, so it can be re-resolved to its new (shifted) index below,
    // the same findEntryIndexForId re-anchor every other items-replacing
    // function (onGroupByChange, toggleSectionCollapse, jumpGroupBoundary)
    // already does. Without this, `selected` silently keeps pointing at
    // whatever raw index it had before the shift — a different, effectively
    // arbitrary photo — and each subsequent backward loadMore (e.g. a
    // virtualization-triggered chain) drifts it further. Confirmed live:
    // this is what made a group-jump's landing photo appear random/erratic
    // rather than simply wrong-but-consistent.
    const selectedEntry = displayEntries[selected];
    const selectedId = selectedEntry ? resolvePhoto(selectedEntry).id : null;
    try {
      const { items: page } = await fetchFeed({
        groupBy,
        collapsed: collapsedPaths,
        focusId,
        before: direction === "before" ? PAGE_SIZE : 0,
        after: direction === "after" ? PAGE_SIZE : 0,
        filter: displayFilter,
        sort,
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
      // Every other items-replacing function updates this status line;
      // loadMore was the one place that didn't, so the "N photos loaded"
      // counter looked permanently stuck at the initial window's count
      // even while more content kept loading correctly in the background —
      // reported as "the group looks cut off," confirmed live: the actual
      // items array and network requests were fine, only this label was
      // stale.
      status = `${items.length} photo${items.length === 1 ? "" : "s"} loaded`;
      enrichMeta(page.map((i) => i.id));
      if (direction === "before" && page.length) {
        await tick();
        if (selectedId != null) {
          const newIndex = findEntryIndexForId(displayEntries, selectedId);
          if (newIndex !== -1) selected = newIndex;
        }
        const gridHeightAfter = gridEl
          ? gridEl.getBoundingClientRect().height
          : 0;
        // While a group-jump pin is active, its boxes reactive re-anchors the
        // landing on THIS very prepend's reflow (reading the tile's post-
        // prepend position). Compensating here too would double-scroll and
        // fling the landing off by the prepended height — so let the pin be
        // the sole scroll authority during its window. Normal scrolling (no
        // pin) still needs this compensation to stay put.
        if (!jumpRevealPending) {
          mainColumnEl.scrollBy(0, gridHeightAfter - gridHeightBefore);
        }
        // scrollBy's own scroll event re-triggers updateVisibleRange,
        // which can call loadMore("before") again. Releasing
        // fetchingBefore in `finally` right after the synchronous
        // scrollBy() call (the old behavior) let that re-triggered call
        // start concurrently with this one's still-settling DOM state —
        // two overlapping calls independently reading gridEl's height
        // for their own before/after compensation, racing each other.
        // Confirmed live: this produced 690 overlapping updateVisibleRange
        // calls in ~5 seconds and a real 23+ request chain walking
        // backward through the entire library after a single jump.
        // Awaiting one frame here doesn't block the re-trigger outright
        // (a re-triggered loadMore("before") can still start once this
        // await resolves) — what it does is keep this call's own guard
        // held until its scroll compensation has had a frame to actually
        // land, so a re-triggered call's measurements are no longer
        // racing this one's mid-flight DOM writes. Confirmed live this
        // is sufficient in practice: the same jump that produced the
        // 690-call cascade now produces exactly the expected handful of
        // requests, with no further loadMore calls once hasMoreBefore's
        // normal termination is reached.
        await new Promise(requestAnimationFrame);
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
  // How many of the nearest-to-selection un-enriched photos to fetch real
  // dimensions for first — a rough viewport's worth, so the content the
  // user is actually looking at settles onto its real aspect ratio quickly
  // instead of waiting on the whole window's metadata in one batch.
  const META_NEAR_BATCH = 24;

  async function enrichMeta(ids) {
    const epoch = feedEpoch;
    const need = ids.filter((id) => {
      const it = items.find((i) => i.id === id);
      return it && it.width == null;
    });
    if (!need.length) return;

    const applyBatch = async (batchIds) => {
      if (!batchIds.length) return;
      try {
        const metas = await fetchMeta(batchIds);
        if (epoch !== feedEpoch) return;
        for (const m of metas) {
          const it = items.find((i) => i.id === m.id);
          if (!it) continue;
          // Record the attempt's outcome unconditionally, even when no
          // usable dimensions came back (RAW: server returns width/height
          // 0) — the "already attempted" check above is `it.width == null`,
          // so leaving width/height unset here would re-request metadata
          // for this photo forever. takenAt is set independently since a
          // RAW file can still have a valid capture date from EXIF despite
          // unavailable dimensions.
          it.width = m.width ?? 0;
          it.height = m.height ?? 0;
          it.takenAt = m.takenAt;
        }
        items = items; // re-layout with real aspect ratios
      } catch {
        // metadata is an enhancement; the grid still works without it
      }
    };

    // Fetching the whole window's metadata in one batch means a single
    // all-at-once reflow once it resolves — visibly jumping whatever the
    // user is currently looking at, including the selected tile. Splitting
    // off the ids nearest the current selection into their own smaller,
    // faster request lets that part of the layout settle first; the rest
    // enriches in the background afterward.
    const focusEntry = displayEntries[selected];
    const focusId = focusEntry ? resolvePhoto(focusEntry).id : null;
    const indexById = new Map(items.map((it, idx) => [it.id, idx]));
    const focusIndex = focusId != null ? (indexById.get(focusId) ?? -1) : -1;
    const distance = (id) => {
      const idx = indexById.get(id);
      return focusIndex === -1 || idx === undefined
        ? Infinity
        : Math.abs(idx - focusIndex);
    };
    const sorted = [...need].sort((a, b) => distance(a) - distance(b));

    await applyBatch(sorted.slice(0, META_NEAR_BATCH));
    // Await the rest too, so the returned promise resolves only once EVERY
    // photo in the batch has its real dimensions (the layout has stopped
    // reflowing). A group-jump `.then()`s on this to re-assert its landing
    // after the above-the-fold rows stop resizing. Callers that don't care
    // (initial load, loadMore) already fire-and-forget.
    await applyBatch(sorted.slice(META_NEAR_BATCH));
  }

  async function refreshLibrary() {
    library = await fetchLibrary().catch(() => library);
  }

  async function onFolderRemoved() {
    await refreshLibrary();
    await loadInitialFeed();
    refreshCounts();
    libraryVersion++;
  }

  async function doScan() {
    if (!dir.trim()) return;
    error = "";
    scanning = true;
    status = "scanning…";
    try {
      if (recursiveScan) {
        // Recursive ("soup folder") scans run as a cancelable background
        // job — live progress shows in the JobsPanel. Single-folder scan
        // stays synchronous below (fast; returns items for immediate render).
        const { jobId } = await startScan(dir.trim(), { recursive: true });
        const job = await waitForJob(jobId);
        if (job.status === "canceled") {
          status = "Scan canceled";
          return;
        }
        if (job.status !== "done") {
          error = job.error || "Scan failed";
          status = "";
          return;
        }
      } else {
        await apiScan(dir.trim(), false);
      }
      localStorage.setItem(LS_KEY, dir.trim());
      refreshLibrary();
      // The scanned folder is now indexed — reload the feed from the
      // start so the newly-scanned photos appear (they may sort anywhere
      // in the current grouping, not necessarily at the loaded window's
      // edge, so a full reset is simpler and correct here).
      await loadInitialFeed();
      refreshCounts();
      libraryVersion++;
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
      // startPath is matched POSITIONALLY against the live groupBy (see
      // server/db/feed.js's startPathCondition — it never reads the
      // `dimension` label), so this only lands on the right rows if
      // "folder" is actually groupBy's first dimension; force that here
      // rather than assuming it (groupBy is a freely reorderable
      // multi-select, unlike the tree sidebar which always derives its
      // path from whatever groupBy[0] currently is).
      if (groupBy[0] !== "folder") {
        groupBy = ["folder", ...groupBy.filter((d) => d !== "folder")];
        collapsedPaths = [];
      }
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

  $: stacks = detectBurstsByGroup(items, groupBy, {
    gapMs: burstEnabled ? burstGapMs : 0,
  });
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
  // computeHeaderPaths annotates each header with its full ancestor path
  // BEFORE suppression — suppress only ever drops *deeper* headers, never an
  // ancestor, so every surviving header's path stays intact. The path both
  // keys the count cache (see loadHeaderCounts) and, spread through the
  // layout, is read by the header template to look up its own count.
  $: sectionHeaders = suppressPlaceholderHeaders(
    computeHeaderPaths(deriveSectionHeaders(resolvedPhotos, groupBy)),
    displayEntries
  );
  // Fetch each visible group's total photo count, one query per *parent*
  // path (the tree API returns every sibling's count in a single GROUP BY),
  // caching so scrolling — which recomputes sectionHeaders on every window
  // change — refetches nothing already known. Runs whenever the header set
  // changes; almost every run is a no-op once a region's counts are cached.
  $: loadHeaderCounts(sectionHeaders, groupBy, countsEpoch);

  async function loadHeaderCounts(headers, groupByAtCall, epoch) {
    for (const parent of headerParentPaths(headers)) {
      const key = pathKey(parent);
      if (fetchedParents.has(key) || inFlightParents.has(key)) continue;
      inFlightParents.add(key);
      let node;
      try {
        node = await fetchTreeNode({ groupBy: groupByAtCall, path: parent, filter: displayFilter, sort });
      } catch {
        inFlightParents.delete(key); // transient failure — allow a retry
        continue;
      }
      inFlightParents.delete(key);
      // A rescan (loadInitialFeed) may have invalidated the cache while this
      // was in flight — dropping a stale result keeps counts honest.
      if (epoch !== countsEpoch) return;
      fetchedParents.add(key);
      const dimension = groupByAtCall[parent.length];
      const next = { ...headerCounts };
      for (const n of node.nodes) {
        next[pathKey([...parent, { dimension, value: n.value }])] = n.count;
      }
      headerCounts = next; // reassign to trigger the template's lookup
    }
  }
  $: layoutResult =
    displayEntries.length && gridWidth > 2 * PAD
      ? sectionedJustifiedLayout(
          displayEntries.map((e) => {
            if (e.kind === "placeholder") {
              return snapshotGroupKeys.has(pathKey(e.item.path))
                ? {
                    id: entryDomId(e),
                    placeholder: true,
                    height: SNAPSHOT_ROW_HEIGHT,
                  }
                : { id: entryDomId(e), placeholder: true };
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
  // How far below the scroll viewport's top a revealed tile should sit: one
  // sticky-header band per grouping level, plus a PAD of breathing room. Used
  // both as the tile's CSS scroll-margin-top (--reveal-margin) and by the
  // jump-landing pin below.
  $: revealMargin = HEADER_HEIGHT * groupBy.length + PAD;
  // Re-pin the group-jump landing on every LAYOUT recompute while pinned, not
  // just on grid-height change (the ResizeObserver's blind spot): a metadata
  // reflow can shrink the rows above the landing while others grow, leaving
  // total grid height ~unchanged — so the observer never fires, yet the
  // landing slides up off the top. `boxes` is a fresh array on every layout
  // recompute, so this fires for exactly those reflows. tick() (a microtask,
  // unlike rAF) defers to just after Svelte patches the DOM, so pinNow reads
  // the tile's final position — and works even in a backgrounded tab.
  $: if (jumpRevealPending && boxes) scheduleJumpPin();
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

  /** Open an arbitrary photo by id (from an album/feed snapshot strip):
   * leave album mode, re-center the feed on it, and open the loupe if the
   * photo landed in the window. Reuses the canonical recenter helper — no
   * new copy of the feed-window guard pattern (issue #42). */
  /** Open an arbitrary photo by id (from an album or feed snapshot strip).
   * The target may sit inside a collapsed/snapshot group (the server never
   * seeks a focusId into a collapsed path), so first make it visible:
   * expand just `groupPath` when known (feed snapshot), else clear all
   * collapse state (album jump has no group context). Then re-center via the
   * canonical helper and open the loupe if it landed in the window. */
  async function openPhotoById(id, groupPath = null) {
    albumMode = false;
    if (groupPath) {
      const key = pathKey(groupPath);
      collapsedPaths = collapsedPaths.filter((p) => pathKey(p) !== key);
      snapshotGroupKeys.delete(key);
      snapshotGroupKeys = snapshotGroupKeys;
    } else {
      collapsedPaths = [];
      snapshotGroupKeys = new Set();
    }
    await recenterFeedOnId(id);
    const idx = findEntryIndexForId(displayEntries, id);
    if (idx !== -1) openLoupe(idx);
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
    // visibleRange's own default overscan (800px each side) roughly
    // triples the mounted area beyond the viewport — measured live: 61
    // tiles mounted (and immediately fetching thumbnails) for only 31
    // actually on screen after a jump. Each extra tile competes for the
    // server's thumbnail-generation throughput, delaying the visible
    // ones on a cold cache — a smaller, explicit overscan here still
    // pre-renders a row or two ahead of ordinary scrolling without
    // flooding a jump with off-screen fetches.
    const range = visibleRange(boxes, {
      scrollTop: -rect.top,
      viewportHeight: mainColumnEl.clientHeight,
      overscanPx: 300,
    });
    renderStart = range.start;
    renderEnd = range.end;

    if (renderEnd >= displayEntries.length - FETCH_THRESHOLD) {
      loadMore("after");
    }
    if (renderStart <= FETCH_THRESHOLD && !jumpRevealPending) {
      // Don't prepend previous-group content while a group-jump landing is
      // still being pinned: the prepend shifts everything below it, and the
      // pin + loadMore's scroll compensation then fight over the landing
      // (flinging it off screen — the intermittent bug, hit only when the
      // jumped-to group sits near a SMALL preceding group, so renderStart
      // lands under the threshold right after the jump). The user doesn't
      // need earlier content the instant they land; it loads the moment they
      // scroll up, which releases the pin (see onKeydown / on:wheel).
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


  async function onKeydown(e) {
    if (e.metaKey || e.ctrlKey) return; // browser shortcuts
    // The user is driving now — cancel any pending post-jump pin (a jump
    // re-arms it at the end of jumpGroupBoundary, after this returns).
    jumpRevealPending = false;

    // Alt+Left/Right jumps groups regardless of what has focus: unlike a
    // bare digit (typing a folder path must not rate photos), Option/Alt
    // plus an arrow never inserts anything into a text field, so there's
    // no legitimate typed input for the "never steal keystrokes from a
    // focused input" guard below to protect here — checked before that
    // guard, or focus sitting in the groupBy pill input (a likely resting
    // place — it's the first, most prominent field on the page) would
    // silently swallow the shortcut, as it did before this reordering.
    if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      if (!displayEntries.length) return;
      await jumpGroupBoundary(e.key === "ArrowRight" ? "next" : "prev");
      return;
    }
    if (e.altKey) return; // other Alt combos: browser shortcuts

    // Never steal keystrokes from a focused input (e.g. typing a folder
    // path with digits in it must not rate photos).
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable)
      return;

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

    // 'X' toggles the focused photo's selection. Works in both grid and loupe
    // so a trip can be culled photo-by-photo from the detail view; in the
    // loupe it auto-advances (like rating) to keep the "look, pick, next" flow.
    if (key.toLowerCase() === "x") {
      e.preventDefault();
      const p = resolvedPhotos[selected];
      if (p && typeof p.id === "number") toggleSelect(p.id);
      if (loupeOpen) {
        const t = nextSelectable(displayEntries, selected + 1, 1);
        if (t !== null) selected = t;
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
        // Shift+arrow extends the selection as you sweep (both endpoints).
        if (t !== null) {
          if (e.shiftKey) selectRange(selected, t);
          selected = t;
        }
      } else if (key === "ArrowLeft" || key === "ArrowUp") {
        e.preventDefault();
        const t = nextSelectable(displayEntries, selected - 1, -1);
        if (t !== null) {
          if (e.shiftKey) selectRange(selected, t);
          selected = t;
        }
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
    else if (key === "ArrowDown")
      next = navVertical(boxes, displayEntries, selected, 1);
    else if (key === "ArrowUp")
      next = navVertical(boxes, displayEntries, selected, -1);
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
    // Shift+arrow extends the selection over every photo swept (inclusive of
    // both the old and new focus), so a run of Shift+Right/Down builds a
    // contiguous selection without the mouse.
    if (e.shiftKey && next !== selected) selectRange(selected, next);
    selected = next;
    await tick();
    // focus (preventScroll) suppresses the browser's native focus scroll;
    // revealSelected is the sole, deliberate reveal for keyboard navigation.
    focusSelectedTile();
    revealSelected();
  }

  /** Alt+Left/Right: jump to the previous/next section-header boundary, at
   * any depth — e.g. the next year within a folder, rolling up to the next
   * folder once the last year in the current one is passed. Resolved
   * server-side (findGroupBoundary) rather than by paging through
   * intermediate photos client-side — a folder in this library can hold
   * 10,000+ photos between here and the boundary. */
  async function jumpGroupBoundary(direction) {
    if (jumpingGroup) return;
    const focusId = safeFocusId(selected);
    if (focusId == null) return;
    jumpingGroup = true;
    try {
      await jumpGroupBoundaryInner(direction, focusId);
    } finally {
      jumpingGroup = false;
      // updateVisibleRange's own reactive trigger (`$: if (boxes) {...}`)
      // fires on every boxes recompute during jumpGroupBoundaryInner's own
      // execution — but at that point fetchingBefore/fetchingAfter are
      // still held true (they're only released in jumpGroupBoundaryInner's
      // own finally, which hasn't run yet), so any "we're near the loaded
      // edge, fetch more" check it makes is silently swallowed by the
      // guard. Nothing re-runs that check once the guard actually clears,
      // so a genuinely-needed loadMore (e.g. the group just jumped away
      // from has thousands more photos before the small window this jump
      // loaded) was never triggered — confirmed live: `hasMoreBefore`
      // stayed `true` and `renderStart` stayed `0` (both conditions for an
      // auto-load satisfied) in the final settled state, but no follow-up
      // /api/feed request ever fired. One more check here, after the
      // guards are genuinely clear, catches it.
      updateVisibleRange();
    }
  }

  async function jumpGroupBoundaryInner(direction, focusId) {
    let boundary;
    try {
      boundary = await fetchGroupBoundary({
        groupBy,
        collapsed: collapsedPaths,
        focusId,
        direction,
        filter: displayFilter,
        sort,
      });
    } catch (err) {
      error = err.message;
      return;
    }
    if (boundary.id == null) return; // already at the first/last group
    const targetId = boundary.id;
    error = "";
    status = "loading…";
    const epoch = ++feedEpoch;
    // See loadInitialFeed's comment: blocks a concurrent scroll-triggered
    // loadMore from splicing a stale page into the window this replaces.
    fetchingBefore = true;
    fetchingAfter = true;
    try {
      // Full PAGE_SIZE each side, not PAGE_SIZE/2 — a jump's initial window
      // used to load only 30+30, so any group bigger than that needed one
      // or more follow-up loadMore round-trips (each a separate network
      // request + layout pass) before it looked complete. Reported as "it
      // takes a while... it should be smooth": the fix that made those
      // follow-ups actually fire (see the finally block below) surfaced
      // this as a visibly staggered load. A bigger up-front window means
      // most real groups (the large majority of this library's folders are
      // under 60 photos) need zero follow-ups at all.
      const { items: beforePage } = await fetchFeed({
        groupBy,
        collapsed: collapsedPaths,
        focusId: targetId,
        before: PAGE_SIZE,
        after: 0,
        filter: displayFilter,
        sort,
      });
      const { items: afterPage, focusItem } = await fetchFeed({
        groupBy,
        collapsed: collapsedPaths,
        focusId: targetId,
        before: 0,
        after: PAGE_SIZE,
        filter: displayFilter,
        sort,
      });
      if (epoch !== feedEpoch) return;
      // A jump can land anywhere in the library, arbitrarily far from
      // wherever the user was scrolled to before — reset scrollTop to 0
      // *before* items/boxes update, so the reactive updateVisibleRange
      // (which fires as soon as boxes recomputes, before revealSelected
      // below ever runs) reads a scroll position that actually matches
      // the new, much shorter document, rather than the OLD, deep-scrolled
      // offset against a document that's now far shorter.
      if (mainColumnEl) mainColumnEl.scrollTop = 0;
      // See dedupeById's comment: these two independent seeks can return
      // overlapping rows once a collapsed-path exclusion is active.
      items = dedupeById([
        ...beforePage,
        ...(focusItem ? [focusItem] : []),
        ...afterPage,
      ]);
      hasMoreBefore = beforePage.length >= PAGE_SIZE;
      hasMoreAfter = afterPage.length >= PAGE_SIZE;
      await tick();
      // findEntryIndexForId, not a plain resolvePhoto(en).id === targetId
      // search: targetId is a server-resolved photo id with no awareness
      // of client-side burst grouping, so it can legitimately be a
      // non-cover member of a collapsed stack — resolvePhoto only ever
      // returns a stack's cover, so a bare equality search would silently
      // miss it and fall through to index 0, landing on an unrelated
      // photo instead of the jump target.
      const targetIndex = findEntryIndexForId(displayEntries, targetId);
      const t =
        targetIndex !== -1
          ? nextSelectable(displayEntries, targetIndex, 1)
          : null;
      selected = t ?? nextSelectable(displayEntries, 0, 1) ?? 0;
      status = `${items.length} photo${items.length === 1 ? "" : "s"} loaded`;
      // Metadata refines the layout (row heights) as it streams in — one of
      // the two reflows the pin below rides out.
      enrichMeta(items.map((i) => i.id));
      await tick();
      // Reveal the landing (native scrollIntoView + the tile's
      // scroll-margin-top puts it below the sticky header). This also moves
      // scrollTop OFF the 0 forced above, which matters: were it left at 0,
      // updateVisibleRange would read the render window as pinned to the start
      // of the loaded feed and call loadMore("before") once per settled frame,
      // walking backward through the whole library (a real, confirmed cascade —
      // 20+ sequential /api/feed?before=60 requests from a single jump).
      revealSelected({ block: "start" });
      focusSelectedTile();
      // ...but this first reveal can't stick on its own: the rows above the
      // landing shrink as their metadata arrives, sliding it off the top.
      // Arming jumpRevealPending drives the pin (the boxes reactive re-anchors
      // it on every reflow — see pinNow) until the user takes over.
      jumpRevealPending = true;
    } catch (err) {
      error = err.message;
      status = "";
    } finally {
      fetchingBefore = false;
      fetchingAfter = false;
    }
  }
</script>

<svelte:window on:keydown={onKeydown} on:resize={scheduleVisibleRangeUpdate} />

<div class="app">
  <header class="topbar">
    <h1>AutoGallery</h1>

    <!-- ① SOURCE -->
    <div class="cluster source">
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
            <li class="library-sep" role="separator"></li>
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
          </ul>
        {/if}
      </div>
      <div class="add-folder">
        <button
          class="add-toggle"
          on:click={() => (addFolderOpen = !addFolderOpen)}
          title="Add / scan a folder"
          aria-label="Add folder"
        >
          ＋
        </button>
        {#if addFolderOpen}
          <div class="add-panel">
            <input
              class="dir"
              type="text"
              placeholder="/path/to/photos"
              bind:value={dir}
              on:keydown={(e) => e.key === "Enter" && doScan()}
              spellcheck="false"
            />
            <label class="recursive-opt" title="Scan this folder and all folders inside it">
              <input type="checkbox" bind:checked={recursiveScan} />
              <span>Include subfolders</span>
            </label>
            <div class="add-actions">
              <button class="scan" on:click={doScan} disabled={scanning}>
                {scanning ? "Scanning…" : "Scan"}
              </button>
              {#if hasNativePicker}
                <button
                  class="choose-folder"
                  on:click={chooseFolder}
                  disabled={scanning}
                >
                  Choose Folder…
                </button>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>

    <div class="divider"></div>

    <!-- ② ORGANIZE & FILTER -->
    <div class="cluster organize">
      <div class="group-by" use:groupBySelector={groupBy}></div>
      <div class="sort-control" title="Sort photos">
        <select
          class="sort-by"
          value={sort.by}
          on:change={(e) => onSortChange({ ...sort, by: e.target.value })}
        >
          {#each SORT_ATTRS as key}
            <option value={key}>{SORT_LABELS[key]}</option>
          {/each}
        </select>
        <button
          class="sort-dir"
          title="Toggle ascending / descending"
          aria-label="Toggle sort direction"
          on:click={() =>
            onSortChange({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })}
        >
          {sort.dir === "asc" ? "↑" : "↓"}
        </button>
      </div>
      <div
        class="seg-toggle"
        role="group"
        aria-label="Filter mode"
        title="Does the filter narrow the view (Display), or add matches to the selection (Select)?"
      >
        <button
          type="button"
          class:active={filterMode === "display"}
          on:click={() => onFilterModeChange("display")}>Display</button
        >
        <button
          type="button"
          class:active={filterMode === "select"}
          on:click={() => onFilterModeChange("select")}>Select</button
        >
      </div>
      <RatingFilter {filter} on:change={(e) => onFilterChange(e.detail)} />
      <OrientationFilter {filter} on:change={(e) => onFilterChange(e.detail)} />
      {#if filterIsActive(filter)}
        <button
          class="clear-filter"
          title="Clear filters"
          aria-label="Clear filters"
          on:click={() => onFilterChange({ ...DEFAULT_FILTER })}
        >
          ✕
        </button>
      {/if}
    </div>

    <div class="divider push"></div>

    <!-- ③ VIEW -->
    <div class="cluster view">
      <div
        class="sidebar-toggle"
        role="group"
        aria-label="Sidebar view"
        style="display:flex;gap:2px;background:#101010;border:1px solid #333;border-radius:6px;padding:2px;"
      >
        <button
          type="button"
          on:click={() => (sidebarMode = "tree")}
          style="border:none;border-radius:4px;padding:3px 9px;font-size:0.8rem;cursor:pointer;{sidebarMode ===
          'tree'
            ? 'background:#4c9aff;color:#06121f;font-weight:600;'
            : 'background:transparent;color:#9a9a9a;'}"
        >
          Tree
        </button>
        <button
          type="button"
          on:click={() => (sidebarMode = "fisheye")}
          style="border:none;border-radius:4px;padding:3px 9px;font-size:0.8rem;cursor:pointer;{sidebarMode ===
          'fisheye'
            ? 'background:#4c9aff;color:#06121f;font-weight:600;'
            : 'background:transparent;color:#9a9a9a;'}"
        >
          Fisheye
        </button>
      </div>
      <button
        class="reveal-btn"
        on:click={revealCurrentLocation}
        title="Reveal the current photo's location in the tree"
      >
        ⌖ Locate
      </button>
      <button
        class="reveal-btn"
        on:click={cycleAllGroups}
        disabled={cyclingAll}
        title="Cycle every group: full view → snapshot all → collapse all"
      >
        {cyclingAll
          ? "…"
          : globalViewMode === "snapshot"
            ? "◐ Snapshot all"
            : globalViewMode === "collapsed"
              ? "▸ Collapsed all"
              : "▦ Full view"}
      </button>
      <button
        class="reveal-btn"
        class:active={albumMode}
        on:click={() => (albumMode ? (albumMode = false) : detectAlbums())}
        disabled={detectingAlbums}
        title="Split the current working set into albums by time gaps"
      >
        {detectingAlbums ? "Detecting…" : albumMode ? "✕ Albums" : "▤ Albums"}
      </button>
      <div class="view-cell">
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
          class="burst"
          title="Group photos taken close in time as a burst"
        >
          <input type="checkbox" bind:checked={burstEnabled} />
          <span class="burst-label">Burst</span>
          <input
            type="range"
            min="0"
            max="10000"
            step="500"
            bind:value={burstGapMs}
            disabled={!burstEnabled}
          />
          <span class="burst-value" class:off={!burstEnabled}
            >{(burstGapMs / 1000).toFixed(1)}s</span
          >
        </label>
      </div>
    </div>

    <div
      class="counts"
      title="Photos in the whole library · shown under the current filter/focus · currently selected"
    >
      <span>{libraryTotal.toLocaleString()} <em>library</em></span>
      <span>{showingCount.toLocaleString()} <em>showing</em></span>
      <span class:has-sel={selectedCount > 0}
        >{selectedCount.toLocaleString()} <em>selected</em></span
      >
    </div>

    {#if keepIds}
      <button
        class="keep-chip"
        on:click={exitKeepOnly}
        title="Exit keep-only focus (back to the whole library)"
      >
        ● Keep-only {keepIds.length.toLocaleString()} ✕
      </button>
    {/if}

    {#if selectedCount > 0}
      <div class="cluster selection">
        <button class="sel-btn" on:click={clearSelection} title="Clear selection"
          >Clear</button
        >
        <button
          class="sel-btn"
          on:click={keepOnlySelection}
          title="Focus the whole app on just these photos (keep only)"
          >Keep only</button
        >
        {#if lastClearedSelection}
          <button
            class="sel-btn undo"
            on:click={undoClearSelection}
            title="Restore the selection you just cleared">Undo</button
          >
        {/if}
        <div class="export-wrap">
          <button
            class="sel-btn export"
            on:click={() => (exportOpen = !exportOpen)}
            title="Copy the selected photos into a new folder">Export…</button
          >
          {#if exportOpen}
            <div class="export-panel">
              <label class="export-field">
                <span>Destination folder</span>
                <div class="export-row">
                  <input
                    class="dir"
                    type="text"
                    placeholder="/path/to/destination"
                    bind:value={exportDest}
                    spellcheck="false"
                  />
                  {#if hasNativePicker}
                    <button class="choose-folder" on:click={chooseExportDest}>
                      Choose…
                    </button>
                  {/if}
                </div>
              </label>
              <label class="export-field">
                <span>New folder name</span>
                <input
                  class="dir"
                  type="text"
                  placeholder="album-name"
                  bind:value={exportName}
                  spellcheck="false"
                />
              </label>
              <div class="export-actions">
                <button
                  class="scan"
                  on:click={doExport}
                  disabled={exporting ||
                    !exportDest.trim() ||
                    !exportName.trim()}
                >
                  {exporting
                    ? "Copying…"
                    : `Copy ${selectedCount} photo${selectedCount === 1 ? "" : "s"}`}
                </button>
              </div>
              {#if exportResult}
                <p class="export-result">
                  Copied {exportResult.copied}{exportResult.skipped
                    ? `, skipped ${exportResult.skipped}`
                    : ""} → {exportResult.target}
                </p>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <span class="status" class:err={!!error}>{error || status}</span>
    {#if thumbProgress}
      <span class="thumb-progress" class:err={thumbCounts.error > 0}>
        {thumbProgress}
      </span>
    {/if}
    {#if manageLibraryOpen}
      <ManageLibrary
        {library}
        on:close={() => (manageLibraryOpen = false)}
        on:folderRemoved={onFolderRemoved}
        on:libraryReset={onLibraryReset}
      />
    {/if}
  </header>

  <div class="app-body">
    {#if sidebarMode === "tree"}
      <TreeSidebar
        bind:this={treeSidebarRef}
        {groupBy}
        {collapsedPaths}
        {sort}
        filter={displayFilter}
        refreshToken={libraryVersion}
        on:toggle={(e) => toggleSectionCollapse(e.detail)}
        on:jump={(e) => jumpToPath(e.detail)}
      />
    {:else}
      <FisheyeSidebar
        {groupBy}
        {currentPath}
        {sort}
        filter={displayFilter}
        refreshToken={libraryVersion}
        on:jump={(e) => jumpToPath(e.detail)}
      />
    {/if}
    <div
      class="main-column"
      bind:this={mainColumnEl}
      on:scroll={scheduleVisibleRangeUpdate}
      on:wheel={() => (jumpRevealPending = false)}
      style="--reveal-margin:{revealMargin}px"
    >
      {#if albumMode}
        <AlbumsView
          photos={albumPhotos}
          truncated={albumTruncated}
          limit={albumLimit}
          {hasNativePicker}
          on:relimit={(e) => onAlbumRelimit(e.detail)}
          on:close={() => (albumMode = false)}
          on:openphoto={(e) => openPhotoById(e.detail.id)}
        />
      {:else if items.length}
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
                    title="Cycle: expanded → snapshot → collapsed"
                    on:click={() =>
                      cycleGroupState(
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
                  {#if header.path && headerCounts[pathKey(header.path)] !== undefined}
                    <span class="section-count">
                      {headerCounts[pathKey(header.path)].toLocaleString()} items
                    </span>
                  {/if}
                  {#if header.path}
                    <span class="section-actions">
                      <button
                        class="section-act"
                        title="Select every photo in this group"
                        on:click|stopPropagation={() => selectGroup(header.path)}
                      >
                        Select
                      </button>
                      <button
                        class="section-act"
                        title="Keep only this group as the working set"
                        on:click|stopPropagation={() => keepOnlyGroup(header.path)}
                      >
                        Keep only
                      </button>
                      {#if header.path.at(-1)?.dimension === "folder"}
                        <button
                          class="section-act"
                          class:danger={removeArmedKey === pathKey(header.path)}
                          title="Remove this album from the library (files on disk are untouched; ratings are lost)"
                          on:click|stopPropagation={() => removeAlbum(header.path)}
                        >
                          {removeArmedKey === pathKey(header.path)
                            ? "Confirm remove"
                            : "Remove"}
                        </button>
                      {/if}
                    </span>
                  {/if}
                </div>
              </div>
            {/each}
            {#each visibleItems as { i, entry } (entryDomId(entry))}
              {#if entry.kind === "placeholder"}
                {#if snapshotGroupKeys.has(pathKey(entry.item.path))}
                  <div
                    class="snapshot-row"
                    style="top:{boxes[i].y}px; height:{boxes[i].height}px;"
                  >
                    <div class="snapshot-head">
                      <button
                        class="snap-cycle"
                        title="Cycle: expanded → snapshot → collapsed"
                        on:click|stopPropagation={() =>
                          cycleGroupState(entry.item.path)}
                      >
                        ◐
                      </button>
                      <span class="snapshot-label" title={entry.item.path
                        .map((p) => formatGroupValue(p.dimension, p.value))
                        .join(" / ")}>
                        {entry.item.path
                          .map((p) => formatGroupValue(p.dimension, p.value))
                          .join(" / ")}
                      </span>
                      <span class="section-count">
                        {entry.item.count.toLocaleString()} items
                      </span>
                      <span class="section-actions">
                        <button
                          class="section-act"
                          title="Select every photo in this group"
                          on:click|stopPropagation={() =>
                            selectGroup(entry.item.path)}
                        >
                          Select
                        </button>
                        <button
                          class="section-act"
                          title="Keep only this group as the working set"
                          on:click|stopPropagation={() =>
                            keepOnlyGroup(entry.item.path)}
                        >
                          Keep only
                        </button>
                        {#if entry.item.path.at(-1)?.dimension === "folder"}
                          <button
                            class="section-act"
                            class:danger={removeArmedKey ===
                              pathKey(entry.item.path)}
                            title="Remove this album from the library (files on disk are untouched; ratings are lost)"
                            on:click|stopPropagation={() =>
                              removeAlbum(entry.item.path)}
                          >
                            {removeArmedKey === pathKey(entry.item.path)
                              ? "Confirm remove"
                              : "Remove"}
                          </button>
                        {/if}
                      </span>
                    </div>
                    <div class="snap-wrap">
                      <SnapshotStrip
                        groupPath={entry.item.path}
                        count={entry.item.count}
                        filter={displayFilter}
                        {sort}
                        {groupBy}
                        thumbPx={SNAPSHOT_ROW_HEIGHT - 44}
                        on:select={(e) => openPhotoById(e.detail.id, entry.item.path)}
                      />
                    </div>
                  </div>
                {:else}
                  <div
                    class="placeholder-row"
                    style="top:{boxes[i].y}px; height:{boxes[i].height}px;"
                    role="button"
                    tabindex="0"
                    on:click={() => cycleGroupState(entry.item.path)}
                    on:keydown={(e) =>
                      e.key === "Enter" && cycleGroupState(entry.item.path)}
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
                    {#if entry.item.path.at(-1)?.dimension === "folder"}
                      <button
                        class="section-act"
                        class:danger={removeArmedKey === pathKey(entry.item.path)}
                        title="Remove this album from the library (files on disk are untouched; ratings are lost)"
                        on:click|stopPropagation={() =>
                          removeAlbum(entry.item.path)}
                      >
                        {removeArmedKey === pathKey(entry.item.path)
                          ? "Confirm remove"
                          : "Remove"}
                      </button>
                    {/if}
                  </div>
                {/if}
              {:else}
                <Thumb
                  item={resolvePhoto(entry)}
                  box={boxes[i]}
                  pad={PAD}
                  size={thumbSize}
                  selected={i === selected}
                  inSelection={selectedIds.has(resolvePhoto(entry).id)}
                  stackCount={entry.kind === "stack" ? entry.stack.count : undefined}
                  stackPeekItems={entry.kind === "stack" ? entry.peekItems : []}
                  stackMarginPx={stackMarginPx(entry)}
                  inExpandedStack={entry.kind === "photo" && entry.stackId !== null}
                  isCurrentCover={entry.kind === "photo" &&
                    entry.stackId !== null &&
                    stacks.find((s) => s.id === entry.stackId)?.coverId === entry.item.id}
                  on:click={(e) => onTileClick(e, entry, i)}
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

<JobsPanel />

{#if loupeOpen}
  <Loupe
    items={resolvedPhotos}
    bind:index={selected}
    inSelection={typeof resolvedPhotos[selected]?.id === "number" &&
      selectedIds.has(resolvedPhotos[selected].id)}
    selectedCount={selectedCount}
  />
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
  .reveal-btn.active {
    background: #2e8b57;
    border-color: #2e8b57;
    color: #06121f;
    font-weight: 600;
  }
  .reveal-btn:disabled {
    opacity: 0.6;
    cursor: default;
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
    flex-wrap: wrap;
    gap: 0.75rem;
    row-gap: 0.45rem;
    padding: 0.6rem 1rem;
    background: #1c1c1c;
    border-bottom: 1px solid #2a2a2a;
  }
  /* Clusters keep their natural width and wrap as whole units, rather than
     shrinking (which squeezed the group-by widget and made it overflow). */
  .cluster {
    flex-shrink: 0;
  }
  .cluster {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
  }
  .cluster.organize {
    flex-wrap: wrap;
  } /* pills wrap WITHIN the cluster, not pushing siblings */
  .divider {
    width: 1px;
    align-self: stretch;
    background: #2a2a2a;
    margin: 2px 0;
  }
  /* Push the View cluster to the right ONLY when everything still fits on one
     row; once the toolbar wraps, the auto-margin collapses and View wraps as a
     normal unit (no odd right-shove on its own row). */
  .divider.push {
    margin-left: auto;
  }

  .add-folder {
    position: relative;
  }
  .add-toggle {
    background: #101010;
    border: 1px solid #333;
    color: #cfcfcf;
    border-radius: 6px;
    padding: 3px 9px;
    font-size: 0.95rem;
    line-height: 1;
    cursor: pointer;
  }
  .add-panel {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 50;
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 260px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .add-actions {
    display: flex;
    gap: 8px;
  }
  .recursive-opt {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    color: #b8b8b8;
    cursor: pointer;
  }

  .view-cell {
    display: flex;
    align-items: center;
    gap: 10px;
    background: #141414;
    border: 1px solid #2f2f2f;
    border-radius: 6px;
    padding: 3px 8px;
  }
  .burst {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 0.78rem;
    color: #9a9a9a;
  }
  .burst input[type="range"] {
    width: 90px;
    accent-color: #4c9aff;
  }
  .burst input[type="range"]:disabled {
    opacity: 0.4;
  }
  .burst-value.off {
    opacity: 0.4;
  }
  .clear-filter {
    background: transparent;
    border: 1px solid #444;
    color: #cfcfcf;
    border-radius: 50%;
    width: 20px;
    height: 20px;
    line-height: 1;
    font-size: 0.7rem;
    cursor: pointer;
  }

  /* Feed sort control: attribute dropdown + direction toggle. */
  .sort-control {
    display: flex;
    align-items: center;
    gap: 2px;
    background: #101010;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 2px;
  }
  .sort-by {
    background: transparent;
    border: none;
    color: #cfcfcf;
    font-size: 0.8rem;
    padding: 3px 4px;
    cursor: pointer;
  }
  .sort-dir {
    border: none;
    border-radius: 4px;
    background: transparent;
    color: #9a9a9a;
    font-size: 0.9rem;
    line-height: 1;
    padding: 3px 7px;
    cursor: pointer;
  }
  .sort-dir:hover {
    background: #222;
    color: #e8e8e8;
  }

  /* Display/Select segmented toggle (matches the sidebar-view toggle). */
  .seg-toggle {
    display: flex;
    gap: 2px;
    background: #101010;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 2px;
  }
  .seg-toggle button {
    border: none;
    border-radius: 4px;
    padding: 3px 9px;
    font-size: 0.8rem;
    cursor: pointer;
    background: transparent;
    color: #9a9a9a;
  }
  .seg-toggle button.active {
    background: #4c9aff;
    color: #06121f;
    font-weight: 600;
  }

  /* Three-level counts: library / showing / selected. */
  .counts {
    display: flex;
    gap: 10px;
    font-size: 0.8rem;
    color: #cfcfcf;
    white-space: nowrap;
  }
  .counts em {
    font-style: normal;
    color: #808080;
  }
  .counts .has-sel {
    color: #ffd24c;
    font-weight: 600;
  }
  .counts .has-sel em {
    color: #b9932f;
  }

  .keep-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: #143a2a;
    border: 1px solid #2e8b57;
    color: #7fe0a8;
    border-radius: 12px;
    padding: 3px 10px;
    font-size: 0.78rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .keep-chip:hover {
    background: #1a4d38;
  }

  .cluster.selection {
    gap: 6px;
  }
  .sel-btn {
    background: #222;
    border: 1px solid #3a3a3a;
    color: #e8e8e8;
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .sel-btn:hover {
    background: #2c2c2c;
  }
  .sel-btn.export {
    background: #4c9aff;
    border-color: #4c9aff;
    color: #06121f;
    font-weight: 600;
  }
  .sel-btn.undo {
    color: #ffd24c;
  }
  .export-wrap {
    position: relative;
  }
  .export-panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 50;
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 300px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .export-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.75rem;
    color: #9a9a9a;
  }
  .export-row {
    display: flex;
    gap: 8px;
  }
  .export-actions {
    display: flex;
  }
  .export-result {
    margin: 0;
    font-size: 0.75rem;
    color: #8fd18f;
    word-break: break-all;
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
  .library-sep {
    height: 1px;
    margin: 4px 0;
    background: #333;
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
  .status {
    color: #9a9a9a;
    font-size: 0.85rem;
    white-space: nowrap;
    flex-shrink: 0;
    margin-left: 0.25rem;
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
  .section-count {
    color: #888;
    font-size: 0.85em;
    font-weight: 400;
    /* Matches the collapsed-section placeholder's own count (.placeholder-count)
       so a section reads the same expanded or collapsed. */
  }
  .section-actions {
    display: inline-flex;
    gap: 4px;
    margin-left: 8px;
    opacity: 0;
    transition: opacity 0.1s ease;
  }
  .section-header:hover .section-actions {
    opacity: 1;
  }
  .section-act {
    background: #222;
    border: 1px solid #3a3a3a;
    color: #cfcfcf;
    border-radius: 4px;
    padding: 1px 7px;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .section-act:hover {
    background: #2f2f2f;
    color: #fff;
  }
  .section-act.danger {
    background: #5a1a1a;
    border-color: #a33;
    color: #ffd7d7;
  }
  .section-act.danger:hover {
    background: #7a2020;
  }
  .snapshot-row {
    position: absolute;
    left: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 4px;
    box-sizing: border-box;
  }
  .snapshot-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .snapshot-label {
    flex: 1 1 auto;
    color: #cfcfcf;
    font-size: 0.82rem;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .snapshot-count {
    flex: 0 0 auto;
    color: #888;
    font-size: 0.78rem;
  }
  .snap-wrap {
    flex: 1 1 auto;
    min-width: 0;
  }
  .snap-cycle {
    flex: 0 0 auto;
    background: #222;
    border: 1px solid #3a3a3a;
    color: #ccc;
    border-radius: 6px;
    cursor: pointer;
    padding: 2px 8px;
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
