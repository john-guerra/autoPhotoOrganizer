<script>
  import { onMount, tick, untrack } from "svelte";
  import { scale } from "svelte/transition";
  import { sectionedJustifiedLayout } from "./lib/layouts/sectionedJustified.js";
  import {
    visibleRange,
    retainWindow,
    runwayPx,
    topAnchorIndex,
    anchorScrollTop,
    aheadRange,
    pageForRunway,
    scrollableHeight,
  } from "./lib/layouts/windowing.js";
  import { ZOOM_LEVELS, resolveZoom, gapFor } from "./lib/zoom.js";
  import { detectBurstsByGroup } from "./lib/bursts.js";
  import {
    applyStackOverrides,
    canCreateManualStack,
  } from "./lib/stackOverrides.js";
  import {
    buildStackMenuItems,
    createManualStackFromSelection,
    dissolveStackMembers,
    selectedStackedMemberIds,
    targetStackMemberIds,
  } from "./lib/stackActions.js";
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
    nearestRealItemId,
    formatGroupValue,
    computeHeaderPaths,
    pathKey,
    headerParentPaths,
  } from "./lib/feed.js";
  import { treeKey } from "./lib/treeState.js";
  import {
    fetchFeed,
    fetchGroupBoundary,
    fetchTreeNode,
    setRating as apiSetRating,
    setCover as apiSetCover,
    fetchMeta,
    fetchPendingMeta,
    startEnrich,
    fetchLibrary,
    scan as apiScan,
    startScan,
    fetchSubdirs,
    startExport,
    fetchPhotoIds,
    fetchPhotoCount,
    fetchAlbumTimeline,
    fetchTimes,
    fetchFlatTree,
    setScope,
    removeFolderByPath,
    renameFolder,
    revealInFinder,
    revealSelection,
    revealFolder,
    fetchMissing,
    thumbUrl,
  } from "./lib/api.js";
  import { buildTreeMenuItems } from "./lib/treeMenu.js";
  import Modal from "./lib/Modal.svelte";
  import {
    jobs,
    waitForJob,
    takeNewlyFinished,
    crossedStep,
  } from "./lib/jobs.js";
  import { isTypingTarget } from "./lib/focus.js";
  import Thumb, { PEEK_STEP_PX, MAX_PEEK_DEPTH } from "./lib/Thumb.svelte";
  import Loupe from "./lib/Loupe.svelte";
  import ContextMenu from "./lib/ContextMenu.svelte";
  import ShortcutsOverlay from "./lib/ShortcutsOverlay.svelte";
  import SettingsPanel from "./lib/SettingsPanel.svelte";
  import Scrubber from "./lib/Scrubber.svelte";
  import { buildManifest } from "./lib/scrubber/scale.js";
  import {
    planPrefetch,
    normalizePrefetch,
    PREFETCH_PRESETS,
    PREFETCH_CONFIG,
  } from "./lib/prefetchPolicy.js";
  import { loadSetting, saveSetting } from "./lib/settings.js";
  import JobsPanel from "./lib/JobsPanel.svelte";
  import GroupStateIcon from "./lib/GroupStateIcon.svelte";
  import FolderIcon from "./lib/FolderIcon.svelte";
  import {
    getRenderer,
    isServerCollapsed,
    nextRendererId,
    DEFAULT_RENDERER_ID,
    SNAPSHOT_ID,
  } from "./lib/groupRenderers.js";
  import { isPathUnder, isKeyUnder } from "./lib/foldPaths.js";
  import ServerBanner from "./lib/ServerBanner.svelte";
  import { startServerWatchdog, serverRestarted } from "./lib/serverHealth.js";
  import TreeSidebar from "./lib/TreeSidebar.svelte";
  import {
    buildTokenStats,
    buildSiblingIndex,
    labelParts,
    dirname,
  } from "./lib/folderLabel.js";
  import { buildFolderTree, relativeTo } from "./lib/folderTree.js";
  import { nestFolderHeaders } from "./lib/folderSections.js";
  import FisheyeSidebar from "./lib/FisheyeSidebar.svelte";
  import UpdateBanner from "./lib/UpdateBanner.svelte";
  import Toolbar from "./lib/Toolbar.svelte";
  import ManageLibrary from "./lib/ManageLibrary.svelte";
  import MissingReview from "./lib/MissingReview.svelte";
  import AlbumsView from "./lib/AlbumsView.svelte";
  import { loadAlbumPrefs, saveAlbumPrefs } from "./lib/albumPrefs.js";
  import SnapshotStrip from "./lib/SnapshotStrip.svelte";
  import {
    folderScope,
    idsScope,
    scopeFilterKeys,
    scopeChip,
    loadScope,
    persistScope,
  } from "./lib/scope.js";
  import {
    selectAll,
    selectNone,
    toggle as toggleSubdir,
    selectedDirs,
  } from "./lib/subfolderSelection.js";
  import {
    nextBulkAction,
    groupLabel,
    restoreSelection,
  } from "./lib/bulkSelection.js";
  import {
    parseStoredSelection,
    toggleId,
    withIds,
    withoutIds,
    rangeIds,
  } from "./lib/selectionOps.js";
  import { combo } from "./lib/platform.js";
  import TimelineFilter from "./lib/TimelineFilter.svelte";
  import SelectionBar from "./lib/SelectionBar.svelte";
  import GroupLabelActions from "./lib/GroupLabelActions.svelte";
  import {
    selectState,
    intersectionCount,
    needsSelectConfirm,
  } from "./lib/groupSelection.js";
  import StatusBar from "./lib/StatusBar.svelte";
  import {
    DEFAULT_FILTER,
    isActive as filterIsActive,
  } from "./lib/filterSpec.js";
  import {
    ALL_DIMENSIONS,
    SORT_ATTRS,
    DATE_SORT_ATTRS,
  } from "./lib/dimensions.js";

  // Injected at build time by Vite (see ui/vite.config.js `define`).
  const APP_VERSION = __APP_VERSION__;

  const LS_KEY = "autogallery.lastDir";
  const LS_ZOOM = "autogallery.zoom"; // legacy: an index, migrated by zoomLevel()
  const LS_ZOOM_PX = "autogallery.zoomPx";
  const LS_BURST_GAP = "autogallery.burstGapMs";
  const DEFAULT_BURST_GAP_MS = 3000;
  const DEFAULT_RATIO = 1.5; // placeholder until real dimensions arrive

  const hasNativePicker =
    typeof window !== "undefined" && !!window.autogallery?.pickFolder;

  // Zoom = target row height of the justified layout. +/- keys or the slider.
  let zoom = $state(
    resolveZoom({
      px: localStorage.getItem(LS_ZOOM_PX),
      legacyIndex: localStorage.getItem(LS_ZOOM),
    })
  );
  $effect(() => {
    localStorage.setItem(LS_ZOOM_PX, String(ZOOM_LEVELS[zoom]));
  });
  let rowHeight = $derived(ZOOM_LEVELS[zoom]);
  let gridGap = $derived(gapFor(rowHeight));

  const storedBurstGap = Number.parseInt(
    localStorage.getItem(LS_BURST_GAP) ?? "",
    10
  );
  let burstGapMs = $state(
    Number.isFinite(storedBurstGap) && storedBurstGap >= 0
      ? storedBurstGap
      : DEFAULT_BURST_GAP_MS
  );
  $effect(() => {
    localStorage.setItem(LS_BURST_GAP, String(burstGapMs));
  });

  const LS_BURST_ENABLED = "autogallery.burstEnabled";
  let burstEnabled = $state(localStorage.getItem(LS_BURST_ENABLED) !== "false"); // default on
  $effect(() => {
    localStorage.setItem(LS_BURST_ENABLED, String(burstEnabled));
  });
  // Request thumbs at the size actually displayed (row height × device pixel
  // ratio), snapped to a few buckets so the disk cache isn't fragmented per
  // pixel. The server caps size at 1024.
  const THUMB_BUCKETS = [160, 320, 480, 640, 1024];
  let thumbSize = $derived(
    THUMB_BUCKETS.find(
      (b) => b >= Math.ceil(rowHeight * (window.devicePixelRatio || 1))
    ) ?? 1024
  );
  // WIP (issue #90 — "collapse to snapshot → thumbs broken"). Snapshot strips
  // reuse the grid's cached thumbnails instead of a unique cold size: follow the
  // grid's current bucket, clamped to [320,640] so it never drops to the
  // always-cold 160 and never over-fetches 1024 for a ~104px slot. Both
  // endpoints are real buckets, so reuse holds at common zooms.
  let snapshotThumbSize = $derived(Math.min(640, Math.max(320, thumbSize)));
  // The loupe filmstrip, same lesson (#90 again): it used to ask for a bare 64px
  // — a size NOTHING else requests — so every loupe open generated up to 81 cold
  // thumbnails while the user was waiting on the full-size photo. Follow the
  // grid's bucket instead: those files already exist, and the browser has them
  // (the thumb URL is immutable). It is drawn at 64px regardless.
  let filmstripThumbSize = $derived(thumbSize);

  let dir = $state(localStorage.getItem(LS_KEY) || "");
  // Recursive "soup folder" scan: pull in every subfolder. Default on — the
  // common case is pointing at a parent of dated album folders.
  const LS_RECURSIVE = "autogallery.recursiveScan";
  let recursiveScan = $state(localStorage.getItem(LS_RECURSIVE) !== "false");
  $effect(() => {
    localStorage.setItem(LS_RECURSIVE, String(recursiveScan));
  });

  // Loupe view toggles (issues #27/#28): details panel + filmstrip, default on,
  // remembered. Toggled with I / F while the loupe is open (see onKeydown).
  const LS_LOUPE_DETAILS = "autogallery.loupeDetails";
  const LS_LOUPE_FILMSTRIP = "autogallery.loupeFilmstrip";
  let showLoupeDetails = $state(
    localStorage.getItem(LS_LOUPE_DETAILS) !== "false"
  );
  let showLoupeFilmstrip = $state(
    localStorage.getItem(LS_LOUPE_FILMSTRIP) !== "false"
  );
  $effect(() => {
    localStorage.setItem(LS_LOUPE_DETAILS, String(showLoupeDetails));
  });
  $effect(() => {
    localStorage.setItem(LS_LOUPE_FILMSTRIP, String(showLoupeFilmstrip));
  });
  const LS_GROUP_BY = "autogallery.groupBy";
  let groupBy = $state(
    (() => {
      try {
        const stored = JSON.parse(localStorage.getItem(LS_GROUP_BY) ?? "null");
        if (
          Array.isArray(stored) &&
          stored.every((d) => ALL_DIMENSIONS.includes(d))
        ) {
          return stored;
        }
      } catch {
        /* fall through to default */
      }
      return ["folder"];
    })()
  );
  $effect(() => {
    localStorage.setItem(LS_GROUP_BY, JSON.stringify(groupBy));
  });

  // Global feed sort (attribute + direction). Threaded into every feed/tree/
  // boundary call; date sorts re-derive the year/month/day grouping (server-side
  // applySortToDims), so grouping and sorting agree on one date notion.
  const LS_SORT = "autogallery.sort";
  let sort = $state(
    (() => {
      try {
        const s = JSON.parse(localStorage.getItem(LS_SORT) ?? "null");
        if (
          s &&
          SORT_ATTRS.includes(s.by) &&
          (s.dir === "asc" || s.dir === "desc")
        )
          return s;
      } catch {
        /* fall through to default */
      }
      // Ascending (oldest first) by default — culling a trip reads best in the
      // order it was shot. Existing users keep their persisted sort (above).
      return { by: "date_taken", dir: "asc" };
    })()
  );
  $effect(() => {
    localStorage.setItem(LS_SORT, JSON.stringify(sort));
  });

  const LS_FILTER = "autogallery.filter";
  let filter = $state(
    (() => {
      try {
        const stored = JSON.parse(localStorage.getItem(LS_FILTER) ?? "null");
        if (stored && typeof stored === "object")
          return { ...DEFAULT_FILTER, ...stored };
      } catch {
        /* fall through to default */
      }
      return { ...DEFAULT_FILTER };
    })()
  );
  $effect(() => {
    localStorage.setItem(LS_FILTER, JSON.stringify(filter));
  });

  // The timeline reflects the feed's SORT date. A date sort becomes the
  // timeline's attribute (and is remembered); a non-date sort (rating/size/name)
  // keeps the last date attr. Seed from the persisted sort/filter so the timeline
  // matches the sort on first paint. `lastDateSort` is the remembered date attr.
  let lastDateSort = untrack(() =>
    DATE_SORT_ATTRS.includes(sort.by)
      ? sort.by
      : DATE_SORT_ATTRS.includes(filter.dateAttr)
        ? filter.dateAttr
        : "date_taken"
  );
  untrack(() => {
    if (filter.dateAttr !== lastDateSort)
      filter = { ...filter, dateAttr: lastDateSort };
  });

  /** The per-photo epoch-ms for a given date attribute, mirroring the server's
   * NULL-safe exprs (COALESCE to mtime), so the "you are here" marker sits on the
   * same date the timeline plots. */
  function photoDateFor(p, attr) {
    if (!p) return null;
    if (attr === "date_modified") return p.mtimeMs ?? null;
    if (attr === "date_created") return p.createdAt ?? p.mtimeMs ?? null;
    const t = p.takenAt; // date_taken (EXIF)
    const taken = t == null ? null : typeof t === "number" ? t : Date.parse(t);
    return taken ?? p.mtimeMs ?? null;
  }

  // --- Selection (multi-select for batch export) --------------------------
  // A persistent Set of photo ids the user has picked. Culling a trip is a
  // long, expensive process, so the selection survives reloads/quits via
  // localStorage (like `filter` above). Ids are stable DB row ids, valid
  // across rescans of the same folder; ids that later vanish (folder removed)
  // are simply skipped by export server-side, so no pruning is needed here.
  const LS_SELECTION = "autogallery.selection";
  let selectedIds = $state(
    new Set(parseStoredSelection(localStorage.getItem(LS_SELECTION)))
  );
  $effect(() => {
    localStorage.setItem(LS_SELECTION, JSON.stringify([...selectedIds]));
  });
  // Stash of the last cleared selection, so Clear is undoable (persists until
  // used or the next clear replaces it — no timed toast, per project taste).
  let lastClearedSelection = $state(null);

  // The app's one working scope — "show me only this". Either a live folder-path
  // predicate or an explicit id set, never both (see lib/scope.js for why the two
  // kinds stay distinct: a folder scope tracks photos scanned into it later and
  // survives a reload, an id set is frozen and session-only). null = whole library.
  // Write it ONLY through applyScope().
  let scope = $state(loadScope());
  $effect(() => {
    persistScope(scope);
  });
  let chip = $derived(scopeChip(scope));

  // Read-only projections, so every existing reader (albums, export, the empty
  // state, activeFacetLabels, the loupe) keeps working unchanged.
  let focusPath = $derived(scope?.kind === "folder" ? scope.path : null);
  let keepIds = $derived(scope?.kind === "ids" ? scope.ids : null);

  // Auto-albums review mode: replaces the grid with a time-gap-clustered view
  // of the working set (see AlbumsView).
  let albumMode = $state(false);
  let albumPhotos = $state([]);
  let albumTruncated = $state(false);
  let detectingAlbums = $state(false);
  // Max photos pulled into the album timeline (user-tunable; server hard-caps).
  let albumLimit = $state(
    Number(localStorage.getItem("autogallery.albumLimit")) || 20000
  );
  // Global Auto-Albums prefs (template/gapMode/fixedGapMs/k/move), persisted
  // in localStorage — see albumPrefs.js. AlbumsView owns the live working
  // copy; its `prefschange` just asks us to persist + re-seed it.
  let albumPrefs = $state(loadAlbumPrefs());
  // Open the Auto-albums setup/explainer modal automatically only the very
  // FIRST time the mode is ever entered (persisted across reloads/sessions —
  // see LS_ALBUM_SETUP_SEEN in detectAlbums); later entries go straight to the
  // review. The ⚙ Options button still opens it on demand.
  const LS_ALBUM_SETUP_SEEN = "autogallery.albumSetupSeen";
  let albumAutoOpenSetup = $state(false);
  // Fallback folder for Auto-Albums' destination/naming default when neither
  // focusPath nor the current groupBy grouping yields a folder (e.g. grouped
  // by year/camera/kind only) — resolved once per detectAlbums() call from
  // the first album photo's own folder, since album-timeline photos
  // (albumPhotos) carry no path of their own (see fetchAlbumTimeline).
  let albumFirstPhotoFolder = $state(null);

  // Filter mode: does the rating/orientation filter narrow what's DISPLAYED
  // (classic), or drive the SELECTION (the grid then shows everything and the
  // matching photos join the selection)? A persisted toggle.
  const LS_FILTER_MODE = "autogallery.filterMode";
  let filterMode = $state(
    localStorage.getItem(LS_FILTER_MODE) === "select" ? "select" : "display"
  );
  $effect(() => {
    localStorage.setItem(LS_FILTER_MODE, filterMode);
  });
  // What the feed/tree/counts actually filter by. In "select" mode the grid
  // is deliberately NOT narrowed — the filter only feeds the selection — so
  // the display filter is the no-op default.
  let displayFilter = $derived({
    ...(filterMode === "select" ? DEFAULT_FILTER : filter),
    // The one scope, projected onto the filter keys the feed/tree/counts speak:
    // a folder scope becomes the live folderPath predicate (a WHERE over
    // folders.abs_path — no id enumeration), an id scope becomes the keepScope
    // flag (the ids themselves live server-side in keep_scope, so it's unbounded).
    ...scopeFilterKeys(scope),
    // dateAttr is which date the timeline PLOTS, not a constraint — so it follows
    // the sort date in both modes (in select mode the rest resets to DEFAULT, but
    // the timeline column must still track the sort).
    dateAttr: filter.dateAttr,
  });

  // --- Timeline filter (brushable density under the toolbar) ----------------
  // The timeline's KDE is a crossfilter: it reflects the OTHER active facets
  // (rating/orientation/keep-scope) but NOT the time range itself, so brushing
  // never collapses the histogram you're brushing within. timesFilter is
  // displayFilter with the time facet stripped; timesKey is its stable
  // signature so we refetch only when the non-time facets or the library
  // change — never on a brush.
  let timeMin = $state(null);
  let timeMax = $state(null);
  let timeTimes = $state([]);
  // The density curve is a SAMPLE above ~12k photos. The server says so; the app
  // used to throw that away and draw the curve as if it were the whole truth —
  // in the one view you brush to find album boundaries.
  let timeSampled = $state(false);
  let timeTotal = $state(0);
  let timesEpoch = 0;
  let timesFilter = $derived.by(() => {
    const { dateFrom, dateTo, ...rest } = displayFilter;
    return rest;
  });
  let timesKey = $derived(JSON.stringify(timesFilter) + "|" + libraryVersion);
  let lastTimesKey = null;
  $effect(() => {
    if (timesKey !== lastTimesKey) {
      lastTimesKey = timesKey;
      refreshTimes(timesFilter);
    }
  });
  async function refreshTimes(spec) {
    const epoch = ++timesEpoch;
    try {
      // Pass the spec directly: toQueryParam sends `dateAttr` even when no other
      // facet is active, so a plain sort-date switch still re-plots the density.
      const r = await fetchTimes(spec);
      if (epoch !== timesEpoch) return; // superseded by a newer refetch
      timeMin = r.min;
      timeMax = r.max;
      timeTimes = r.times;
      timeSampled = !!r.sampled;
      timeTotal = r.total ?? 0;
    } catch (e) {
      // Non-fatal: the strip just hides (timeMin stays null); feed unaffected.
      if (epoch === timesEpoch) {
        timeMin = null;
        timeMax = null;
        timeTimes = [];
        timeSampled = false;
        timeTotal = 0;
      }
    }
  }

  // Three live counts the user asked for: whole library, currently shown
  // (under displayFilter), and selected. selectedCount is reactive off the Set.
  let libraryTotal = $state(0);
  let showingCount = $state(0);
  let selectedCount = $derived(selectedIds.size);

  // Export popover state (mirrors the add-folder popover).
  const LS_EXPORT_DEST = "autogallery.exportDest";
  let exportOpen = $state(false);
  let exportDest = $state(localStorage.getItem(LS_EXPORT_DEST) || "");
  let exportName = $state(defaultExportName());
  // MOVE the originals instead of copying. Off by default and never remembered:
  // a destructive default is how people lose photos. It is undoable (the job
  // carries a manifest), and the UI says so before you commit.
  let exportMove = $state(false);
  let exporting = $state(false);
  let exportResult = $state(null);
  // Metadata reading: `rereading` = a forced re-read of the selection is in
  // flight; `sweeping` = the read-everything-unread job is; `pendingMeta` = how
  // many photos have never been read (0 hides the sweep button).
  let rereading = $state(false);
  let sweeping = $state(false);
  let pendingMeta = $state(0);

  // Sidebar view: classic "tree" or focus+context "fisheye" (toggle, persisted).
  // --- Resizable sidebar (drag its right edge; width persisted) -------------
  const DEFAULT_SIDEBAR_WIDTH = 260;
  const MIN_SIDEBAR_WIDTH = 150;
  const MAX_SIDEBAR_WIDTH = 640;
  const LS_SIDEBAR_WIDTH = "autogallery.sidebarWidth";
  const clampSidebar = (w) =>
    Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(w)));
  let sidebarWidth = $state(
    (() => {
      const stored = Number(localStorage.getItem(LS_SIDEBAR_WIDTH));
      return Number.isFinite(stored) && stored > 0
        ? clampSidebar(stored)
        : DEFAULT_SIDEBAR_WIDTH;
    })()
  );
  $effect(() => {
    localStorage.setItem(LS_SIDEBAR_WIDTH, String(sidebarWidth));
  });
  let resizingSidebar = $state(false);

  /** Pointer-capture drag so the resize keeps tracking even when the cursor
   * outruns the 5px handle (a plain mousemove-on-handle loses it instantly). */
  function startSidebarResize(e) {
    e.preventDefault();
    resizingSidebar = true;
    const startX = e.clientX;
    const startW = sidebarWidth;
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    const onMove = (ev) =>
      (sidebarWidth = clampSidebar(startW + ev.clientX - startX));
    const onUp = (ev) => {
      resizingSidebar = false;
      handle.releasePointerCapture?.(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  /** Keyboard-resizable too — the handle is focusable, so arrows nudge it. */
  function onSidebarResizeKey(e) {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      sidebarWidth = clampSidebar(sidebarWidth - step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      sidebarWidth = clampSidebar(sidebarWidth + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
    }
  }

  // Scrubber rail width — resizable and persisted, so long folder/landmark names
  // are readable as wide as you want (mirrors the sidebar resizer; the handle
  // sits on the rail's LEFT edge, so dragging left widens it).
  const DEFAULT_SCRUBBER_WIDTH = 54;
  const MIN_SCRUBBER_WIDTH = 40;
  const MAX_SCRUBBER_WIDTH = 360;
  const LS_SCRUBBER_WIDTH = "autogallery.scrubberWidth";
  const clampScrubber = (w) =>
    Math.max(MIN_SCRUBBER_WIDTH, Math.min(MAX_SCRUBBER_WIDTH, Math.round(w)));
  let scrubberWidth = $state(
    (() => {
      const stored = Number(localStorage.getItem(LS_SCRUBBER_WIDTH));
      return Number.isFinite(stored) && stored > 0
        ? clampScrubber(stored)
        : DEFAULT_SCRUBBER_WIDTH;
    })()
  );
  $effect(() => {
    localStorage.setItem(LS_SCRUBBER_WIDTH, String(scrubberWidth));
  });
  let resizingScrubber = $state(false);

  function startScrubberResize(e) {
    e.preventDefault();
    resizingScrubber = true;
    const startX = e.clientX;
    const startW = scrubberWidth;
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    // Handle is on the rail's left edge: moving the cursor LEFT (negative delta)
    // widens the rail.
    const onMove = (ev) =>
      (scrubberWidth = clampScrubber(startW - (ev.clientX - startX)));
    const onUp = (ev) => {
      resizingScrubber = false;
      handle.releasePointerCapture?.(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  function onScrubberResizeKey(e) {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      scrubberWidth = clampScrubber(scrubberWidth + step); // left = wider
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      scrubberWidth = clampScrubber(scrubberWidth - step);
    } else if (e.key === "Home") {
      e.preventDefault();
      scrubberWidth = DEFAULT_SCRUBBER_WIDTH;
    }
  }

  const LS_SIDEBAR_MODE = "autogallery.sidebarMode";
  let sidebarMode = $state(
    localStorage.getItem(LS_SIDEBAR_MODE) === "fisheye" ? "fisheye" : "tree"
  );
  $effect(() => {
    localStorage.setItem(LS_SIDEBAR_MODE, sidebarMode);
  });
  let collapsedPaths = $state([]); // Array<Array<{dimension,value}>>, reset on hierarchy change
  // rendererIdFor() is called ~3x per header per render (class, title, icon) plus
  // once per placeholder in the layout. Scanning collapsedPaths with a
  // JSON.stringify compare each time was O(headers x collapsedPaths) stringifies
  // per render — brutal after Collapse-all or a 400-leaf shift-fold, on top of
  // the known large-selection stall (#97). Derive the key set ONCE.
  let collapsedKeys = $derived(new Set(collapsedPaths.map(pathKey)));
  // Groups rendered as a one-line SnapshotStrip instead of the collapsed
  // pill. A group in this set is ALSO server-collapsed (its path lives in
  // collapsedPaths, per the tri-state design in
  // docs/superpowers/specs/2026-07-09-fisheye-snapshot-view-design.md) —
  // this set only decides how the client renders that collapsed placeholder.
  // Keyed by pathKey(path), reset on hierarchy change alongside collapsedPaths.
  let snapshotGroupKeys = $state(new Set());
  // A snapshot band is exactly ONE GRID ROW tall — it follows the zoom, like the
  // photos it stands in for. It used to be a fixed 148px ("group label row on top
  // + the strip beneath"), which stopped being true when the label moved into the
  // section header and renderers stopped drawing chrome: the number stayed, and
  // the strip's photos ended up a different size from the same group's photos in
  // full view, at every zoom level.
  let snapshotRowHeight = $derived(rowHeight);
  // Last global view action (the top-of-toolbar "cycle all" control); the
  // per-group toggles may diverge from it, but the button just applies the
  // next whole-view state each click: full view → snapshot all → collapse all.
  // A GROUP_RENDERERS id — the whole-view control cycles the same registry order
  // the per-group toggle does.
  let globalViewMode = $state(DEFAULT_RENDERER_ID);
  let cyclingAll = $state(false);
  // Two-click confirm for "remove album from library" (drops the folder's rows
  // + ratings from the index; files on disk are untouched). Holds the pathKey
  // of the group armed for removal; the next click on the same group commits.
  let removeArmedKey = $state(null);
  let treeSidebarRef = $state(); // bound to TreeSidebar, for revealCurrentLocation to call revealPath
  let items = $state([]); // the currently-loaded feed window, ordered
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
  let jumpingGroup = false; // plain guard: never read in a reactive context
  // True from a group-jump's landing until its window's metadata finishes
  // loading — the cue to re-assert the landing once (the above-the-fold rows
  // resize as their dimensions arrive, drifting the one-shot landing down).
  // Cleared the instant the user takes over (a keypress or wheel/trackpad
  // scroll), so the re-assert never fights them. Not a timer.
  let jumpRevealPending = $state(false);
  // Expanding a collapsed group must not move its header on screen: the header
  // holds the exact viewport offset it had at the click while the group's
  // photos grow downward below it (issue #74). Set to {key, offset} at expand
  // time and re-asserted on every layout recompute (like jumpRevealPending)
  // until the user takes over, because the focusId-recenter that re-fetches the
  // group replaces the whole feed window — so the header's grid Y is rebuilt
  // and a one-shot scroll can't hold it. Cleared on the user's first keypress/
  // wheel. Not a timer.
  let expandPin = $state(null); // { key: string, offset: number } | null
  // Per-group photo counts shown on each section header, so the user knows
  // how many photos a group holds before scrolling it (the loaded window is
  // only a slice; a group can hold thousands). Keyed by pathKey(group path).
  // A count depends ONLY on that path's constraints (WHERE folder=… AND
  // year=…), never on groupBy order or the loaded window, so the cache is
  // valid for the whole session and is only reset when a rescan can change
  // the underlying photos (loadInitialFeed bumps countsEpoch). headerCounts
  // is reassigned (not mutated) to stay reactive; the two Sets are plain
  // bookkeeping and needn't be.
  let headerCounts = $state({}); // pathKey(fullPath) -> number
  let fetchedParents = new Set(); // pathKey(parentPath) already resolved — plain bookkeeping
  let inFlightParents = new Set(); // pathKey(parentPath) mid-fetch (dedup) — plain bookkeeping
  // The folder level's raw tree-API rows, per parent path — the SAME response
  // loadHeaderCounts already fetches for the counts, kept so the feed can build
  // the folder trie from it. Nesting the feed's folders therefore costs no extra
  // request. Reassigned (never mutated) so the derivation below re-runs.
  let folderNodesByParentKey = $state(new Map()); // pathKey(parentPath) -> [{value,count}]
  let countsEpoch = $state(0);
  const PAGE_SIZE = 60;
  // Ceiling for adaptive loadMore("after") pages. A fling at the smallest zoom
  // consumes hundreds of items per fetch round-trip, so a fixed 60 lets the user
  // out-scroll the loader (the reported "reach the end before it loads more").
  // updateVisibleRange scales the page to the on-screen pixel density up to this
  // cap; appended content lands BELOW the viewport so a large page never shifts
  // what the user is looking at. See prefetchPolicy.bench.test.js (Experiment B).
  const PAGE_SIZE_MAX = 600;
  const FETCH_THRESHOLD = 20; // floor: fetch when within this many entries of an edge
  // The real trigger (see updateVisibleRange): keep at least two viewports of
  // loaded content beyond each edge, so a fast scroll still has runway left while
  // the next page is in flight. 1200px is the floor for a short window — at a
  // fling's 3,000-6,000 px/s even that is only ~300ms, which a ~1ms feed query
  // (2.12.7) plus render comfortably fits inside.
  const MIN_RUNWAY_PX = 1200;
  let status = $state("");
  let error = $state("");
  let scanning = $state(false);
  let feedEpoch = 0; // invalidates in-flight meta fetches when the window resets (plain guard)
  let library = $state([]);
  // Bumped whenever the library's photo set changes (scan, folder removal,
  // full reset). The sidebars key their refetch on this so they always mirror
  // the real index, not just groupBy/filter changes.
  let libraryVersion = $state(0);
  let addFolderOpen = $state(false);
  let manageLibraryOpen = $state(false);
  let missingReviewOpen = $state(false);
  let missingCount = $state(0);
  // A calm, informational nudge ("N files went missing …") — its own channel so
  // it renders in a neutral style, NOT the red error style. See reportScanMissing.
  let missingNotice = $state("");
  // Scope to the folder once it's in? (The old "Open a folder…" entry, now an
  // option on the one Add panel rather than a second door to the same room.)
  let focusAfterAdd = $state(false);
  // "Already in your library": the path itself, or any subtree of it, is a
  // scanned folder. Decides the Add button's verb (Add & scan / Rescan / Open)
  // and whether opening it needs a scan at all.
  let alreadyIndexed = $derived(
    !!dir.trim() &&
      library.some(
        (e) => e.path === dir.trim() || e.path.startsWith(dir.trim() + "/")
      )
  );

  // The subfolder checklist (see lib/subfolderSelection.js). Collapsed until the
  // user asks for it, so a plain add never waits on a directory walk.
  let subdirsOpen = $state(false);
  let subdirs = $state([]);
  let subdirsLoading = $state(false);
  let subdirsError = $state("");
  let subdirSelection = $state(new Set());

  // A checklist built for a different folder is worse than none — drop it the
  // moment the path changes. Reads `dir`; resetSubdirs writes only the subdir*
  // state (never `dir`), so this effect cannot loop.
  $effect(() => {
    dir;
    resetSubdirs();
  });
  function resetSubdirs() {
    subdirsOpen = false;
    subdirs = [];
    subdirsError = "";
    subdirSelection = new Set();
  }

  /** Walk the folder for its scannable subdirs. Any failure (permission denied,
   * unmounted, vanished) is shown in the panel, naming the path — never an
   * empty list that looks like "no subfolders". */
  async function loadSubdirs() {
    const p = dir.trim();
    if (!p) return;
    subdirsLoading = true;
    subdirsError = "";
    try {
      subdirs = await fetchSubdirs(p);
      subdirSelection = selectAll(subdirs);
    } catch (e) {
      subdirsError = e.message;
      subdirs = [];
      subdirSelection = selectNone();
    } finally {
      subdirsLoading = false;
    }
  }

  let selected = $state(0); // index into displayEntries; must never land on a
  // {kind:'placeholder'} entry — see nextSelectable below.

  /**
   * Has the user actually PUT focus somewhere (clicked a tile, arrowed to one),
   * as opposed to `selected` merely starting at 0 so the keyboard has an anchor?
   *
   * Only an explicit focus arms click-to-open-the-loupe. Without this, photo #1
   * counted as "already focused" from the moment the app loaded, so one click on
   * it opened the loupe while every other tile needed two — and in the loupe,
   * rating auto-advances, so a user who landed there by accident rated a
   * different photo with every keystroke (issue #104).
   */
  let focusIsExplicit = false; // plain: read only imperatively in onTileClick

  /** The one place that records a deliberate focus. Use it instead of assigning
   *  `selected` directly whenever the USER moved the focus. */
  function focusEntry(index) {
    selected = index;
    focusIsExplicit = true;
  }

  let loupeOpen = $state(false);
  let shortcutsHelpOpen = $state(false); // '?' toggles the keyboard-shortcuts overlay
  let settingsOpen = $state(false); // ',' toggles the scrolling/prefetch settings

  // --- Scrolling / prefetch settings (persisted) --------------------------
  // Which prefetch strategy is live, plus the Custom knob values and the
  // adaptive-page-size switch. The winner of prefetchPolicy.bench.test.js is the
  // default; the settings panel lets the user A/B any preset live (John wanted
  // visual controls to feel the difference on real hardware). Persisted via
  // localStorage so a choice survives a reload.
  let prefetchPreset = $state(loadSetting("prefetchPreset", "balanced"));
  let prefetchCustom = $state(
    normalizePrefetch(loadSetting("prefetchCustom", PREFETCH_PRESETS.balanced))
  );
  // The real "reach the end before it loads more" fix: scale each loadMore fetch
  // to the on-screen pixel density instead of a fixed 60 items. On by default;
  // the benchmark showed it takes small-thumb fling blanking from ~70% to 0%.
  let adaptivePageSize = $state(loadSetting("adaptivePageSize", true));
  // The config the grid actually runs with this frame.
  const prefetchConfig = $derived(
    prefetchPreset === "custom"
      ? normalizePrefetch(prefetchCustom)
      : (PREFETCH_PRESETS[prefetchPreset] ?? PREFETCH_CONFIG)
  );
  $effect(() => saveSetting("prefetchPreset", prefetchPreset));
  $effect(() => saveSetting("prefetchCustom", $state.snapshot(prefetchCustom)));
  $effect(() => saveSetting("adaptivePageSize", adaptivePageSize));

  // Scrubber rail axis: "count" (position ∝ cumulative photos — tracks scroll) or
  // "value" (position ∝ sort value, e.g. time — like the top timeline). Persisted
  // so it can be A/B'd like the prefetch presets.
  let scrubberAxis = $state(loadSetting("scrubberAxis", "count"));
  $effect(() => saveSetting("scrubberAxis", scrubberAxis));

  let gridEl = $state();
  let mainColumnEl = $state();
  let gridWidth = $state(0);

  // Virtualization: only Thumbs in [renderStart, renderEnd] (plus the
  // selected index) are mounted. Recomputed on scroll/resize/layout change.
  let renderStart = $state(0);
  let renderEnd = $state(-1);
  let rafPending = false; // plain guard (scheduleVisibleRangeUpdate)
  // Scroll anchoring (layout stability): domId + grid-local y of the top-most
  // visible tile, captured on scroll/resize. When a layout recompute (metadata
  // streaming in, resize, zoom) moves that tile, the anchor effect below shifts
  // scrollTop by its delta so the user's eye-point never jumps. Plain `let`, NOT
  // $state: capture/restore must not be reactive, or the restore effect would
  // re-fire on its own write. Reset on a full window replace (see focusPending).
  let layoutAnchor = null; // { domId: number|string, y: number } | null
  let focusPending = $state(false); // set after a scan; consumed once `boxes` exists
  let expandedStackIds = $state(new Set()); // stack ids currently expanded inline in the grid

  // Aggregate thumbnail load progress across the whole grid, fed by each
  // Thumb's attempt/settled events (Map mutations aren't reactive on their
  // own, hence thumbStatusTick as an explicit dependency). Reset per scan so
  // a rescan's ids don't inherit a stale previous scan's counts.
  let thumbStatus = $state(new Map()); // id -> 'pending' | 'ok' | 'error'
  // Kept as an explicit trigger too (the derived reads it) — redundant now that
  // thumbStatus is deeply reactive, but harmless and avoids churn.
  let thumbStatusTick = $state(0);
  function handleThumbAttempt({ id }) {
    thumbStatus.set(id, "pending");
    thumbStatusTick++;
  }
  function handleThumbSettled({ id, ok }) {
    thumbStatus.set(id, ok ? "ok" : "error");
    thumbStatusTick++;
  }
  let thumbCounts = $derived.by(() => {
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
  });
  let thumbProgress = $derived(
    thumbCounts.pending > 0
      ? `loading thumbnails… ${thumbCounts.ok} loaded${thumbCounts.error ? `, ${thumbCounts.error} failed` : ""}`
      : thumbCounts.error > 0
        ? `${thumbCounts.error} thumbnail${thumbCounts.error === 1 ? "" : "s"} failed to load`
        : ""
  );

  onMount(() => {
    // Show the version in the browser tab / Electron window title. Electron's
    // BrowserWindow title follows document.title by default, so this covers
    // both surfaces.
    document.title = `AutoGallery v${APP_VERSION}`;
    refreshLibrary();
    loadInitialFeed();
    refreshCounts();
    refreshMissingCount();
  });

  /** THE one guarded feed-window-replace transaction (issue #42). Every
   * function that discards `items` and rebuilds the window from scratch shares
   * this exact guard, so it lives here once instead of being hand-copied: reset
   * error/status, bump `feedEpoch`, and hold `fetchingBefore`/`fetchingAfter`
   * for the whole duration so a concurrent scroll-triggered `loadMore` started
   * against the OLD window can't resolve afterwards and splice its now-stale
   * page into the NEW `items` — that produced duplicate rows and duplicate
   * Svelte keys (`{#each}` throws and the grid "freezes"). `body` receives the
   * epoch it owns and MUST re-check `epoch !== feedEpoch` after each await
   * before mutating shared state (a fetch it awaited may have been superseded
   * by a newer transaction). On a thrown error this sets `error`, clears
   * `status`, and returns `onError`. Replaces six near-identical copies of this
   * pattern — see CLAUDE.md's "no 7th copy" rule.
   * @template T
   * @param {(epoch: number) => Promise<T>} body
   * @param {{ onError?: T }} [opts]
   * @returns {Promise<T | undefined>}
   */
  async function withFeedTransaction(body, { onError } = {}) {
    // FLUSH FIRST. `displayFilter` is a `$:` derived value, so it does NOT exist
    // yet at the moment a handler sets `filter` — Svelte recomputes it at the end
    // of the tick. Every caller here sets the state and rebuilds the feed in the
    // same handler, so a body that reads `displayFilter` synchronously reads the
    // PREVIOUS filter and fetches the wrong photos.
    //
    // It hid for so long because most rebuilds fetch twice (a before-seek and an
    // after-seek around the focused photo): the second fetch happens after an
    // await, by which time Svelte has flushed, so the right filter arrives and
    // papers over the wrong one. The path with no focus id fetches ONCE — and
    // that one lost outright, replacing the window with the whole unfiltered
    // library (or nothing at all, if the first load hadn't landed yet, which is
    // how it was reported: "1 showing" over an empty grid).
    await tick();
    error = "";
    status = "loading…";
    const epoch = ++feedEpoch;
    fetchingBefore = true;
    fetchingAfter = true;
    try {
      return await body(epoch);
    } catch (e) {
      error = e.message;
      status = "";
      return onError;
    } finally {
      fetchingBefore = false;
      fetchingAfter = false;
    }
  }

  async function loadInitialFeed() {
    thumbStatus = new Map();
    thumbStatusTick++;
    // A rescan can add/remove photos, changing group counts — invalidate the
    // header-count cache so it refetches (bumping the epoch also discards any
    // count fetch still in flight from the previous window).
    countsEpoch++;
    headerCounts = {};
    fetchedParents = new Set();
    inFlightParents = new Set();
    await withFeedTransaction(async (epoch) => {
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
    });
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
    // Timeline follows the sort date: a date sort becomes (and is remembered as)
    // the timeline's attribute; a non-date sort keeps the last date attr. Updating
    // filter.dateAttr re-plots the density (via timesKey) and re-bounds the brush.
    if (DATE_SORT_ATTRS.includes(next.by)) lastDateSort = next.by;
    if (filter.dateAttr !== lastDateSort)
      filter = { ...filter, dateAttr: lastDateSort };
    rebuildFeedForFilterOrSort();
  }

  /** Apply a new filter spec. In "display" mode this narrows the grid: the
   * header-count cache is now stale (same paths, different counts), so
   * invalidate it, then rebuild the feed centered on the current selection via
   * onGroupByChange's existing guarded loader (reused deliberately rather than
   * duplicating its fetchingBefore/After/feedEpoch guard — see CLAUDE.md's "no
   * 7th copy" rule). In "select" mode the grid is NOT narrowed (displayFilter
   * stays default), so the feed is untouched — instead the matching photos are
   * unioned into the selection. */
  /** Reset every filter facet (and exit keep-only) — the empty-state "Clear
   * filters" action. Preserves dateAttr so the timeline keeps following the sort
   * date rather than snapping back to date_taken. */
  function clearAllFilters() {
    if (scope) exitScope();
    onFilterChange({ ...DEFAULT_FILTER, dateAttr: filter.dateAttr });
  }

  // Human names of the currently-active filter facets, for the empty-state hint
  // (so it says exactly what's hiding the photos, not a generic list).
  let activeFacetLabels = $derived.by(() => {
    const f = [];
    if ((filter.minRating ?? 0) > 0) f.push(`${filter.minRating}+ stars`);
    const o = filter.orientations ?? [];
    if (o.length > 0 && o.length < 3) f.push("orientation");
    if (filter.dateFrom != null || filter.dateTo != null) f.push("time range");
    if (keepIds) f.push("keep-only scope");
    if (focusPath) f.push("folder focus");
    return f;
  });

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
    rebuildFeedForFilterOrSort();
    refreshCounts();
  }

  /** Rebuild the feed after a filter or sort change (same hierarchy, different
   * groups/order). A whole-view mode (snapshot-all / collapse-all) is sticky: the
   * groups that (re)appear inherit it, rather than snapping back to expanded. In
   * expanded mode this is the plain reset-and-recenter path. */
  async function rebuildFeedForFilterOrSort() {
    if (!isServerCollapsed(globalViewMode)) {
      await onGroupByChange(groupBy);
    } else {
      await applyViewModeToGroups(globalViewMode);
      await loadInitialFeed();
    }
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
      selectedIds = withIds(selectedIds, ids);
    } catch (e) {
      error = e.message;
    }
  }

  // --- Group tri-state selection indicator (issue #88) -------------------
  // A group label shows none/some/all of its photos selected. The client only
  // holds a flat `selectedIds` set, so we cache each group's id list (fetched
  // lazily, once, for visible headers) and intersect it with the selection.
  // Entries are tagged with the current filter+sort signature so a stale one is
  // ignored after the feed's ordering/filtering changes.
  let groupIdCache = new Map(); // pathKey -> { ids: number[], sig: string } (plain; groupIdCacheVersion is the reactive trigger)
  let groupIdCacheVersion = $state(0); // bumped when the cache changes, to re-derive
  let groupIdInFlight = new Set(); // pathKeys mid-fetch (dedup) — plain bookkeeping
  let groupSelSig = $derived(
    JSON.stringify([displayFilter ?? null, sort ?? null])
  );
  // Drop cached group ids whenever the header/count caches reset — the one
  // signal (`countsEpoch`) that fires on every filter / keep-only / groupBy /
  // rescan / library-reset, i.e. exactly when a group's membership can change.
  // Reads countsEpoch (tracked) + _groupCacheEpoch (plain guard); writes the
  // plain guard + plain caches + the version signal, none of which it reads —
  // so it cannot loop.
  let _groupCacheEpoch = 0;
  $effect(() => {
    if (countsEpoch !== _groupCacheEpoch) {
      _groupCacheEpoch = countsEpoch;
      groupIdCache = new Map();
      groupIdInFlight = new Set();
      // Drop queued fetches too: their sig is now stale, and the next render
      // re-enqueues whatever is still needed. In-flight ones finish harmlessly
      // (groupSelectState re-checks sig before trusting a cached entry).
      _groupIdQueue.length = 0;
      groupIdCacheVersion++;
    }
  });

  // The tri-state fetch is bounded. A wide feed (or a fully-expanded folder
  // tree) renders hundreds-to-thousands of headers at once, and each uncached
  // one wants its own /api/photos/ids. Fired unbounded, ~1,000 requests land on
  // the browser's ~6-connections-per-host cap simultaneously and STARVE the
  // requests that actually matter — the feed page and the tree reload — which
  // then fail with "Failed to fetch" and leave the grid looking empty. Draining
  // the id fetches a few at a time keeps connection slots free for the critical
  // requests; the indicator just fills in progressively (it already shows
  // "loading"). Kept well under the cap so the feed/tree never wait behind it.
  const GROUP_ID_MAX_CONCURRENT = 3;
  let _groupIdActive = 0;
  const _groupIdQueue = []; // pending fetch thunks, drained by pumpGroupIdQueue
  function pumpGroupIdQueue() {
    while (_groupIdActive < GROUP_ID_MAX_CONCURRENT && _groupIdQueue.length) {
      const job = _groupIdQueue.shift();
      _groupIdActive++;
      job().finally(() => {
        _groupIdActive--;
        pumpGroupIdQueue();
      });
    }
  }

  /** Kick off a one-shot id fetch for a group whose ids aren't cached yet.
   *  Enqueued rather than fired immediately — see GROUP_ID_MAX_CONCURRENT. */
  function ensureGroupIds(path, paths, key, sig) {
    if (groupIdInFlight.has(key)) return;
    groupIdInFlight.add(key);
    _groupIdQueue.push(async () => {
      try {
        const ids = await fetchGroupIds(path, paths);
        groupIdCache.set(key, { ids, sig });
        groupIdCacheVersion++; // trigger the reactive re-derive
      } catch {
        // Leave uncached; a later render retries. The click path surfaces errors.
      } finally {
        groupIdInFlight.delete(key);
      }
    });
    pumpGroupIdQueue();
  }

  /** Derive a group's select indicator. Reads reactive `_sel`/`_ver`/`_sig` as
   * args so Svelte re-runs this in the template when selection or cache change.
   *
   * `paths` is the group's SUBTREE (see fetchGroupIds), and it has to be the same
   * subtree the click acts on. It didn't used to be: the indicator counted only
   * the folder's own photos while the click selected the whole subtree, so a
   * parent could sit there reading "none" with every photo under it selected —
   * and a virtual ancestor, which owns no photos at all, counted zero of zero and
   * never lit up.
   * @returns {"none"|"some"|"all"|"loading"} */
  function groupSelectState(path, paths, _sel, _ver, _sig) {
    // Nothing selected ⇒ every group is trivially "none": intersecting an empty
    // selection can only be empty. Short-circuit BEFORE ensureGroupIds so plain
    // browsing/searching (the common case, and no-selection is exactly the state
    // of the original #4 repro) never fires a single per-group id request. This
    // alone eliminates the whole request storm whenever the user has no
    // selection active.
    if (_sel.size === 0) return "none";
    const key = pathKey(path);
    const entry = groupIdCache.get(key);
    if (!entry || entry.sig !== _sig) {
      ensureGroupIds(path, paths, key, _sig);
      return "loading";
    }
    return selectState(intersectionCount(entry.ids, _sel), entry.ids.length);
  }

  /** Cmd/Ctrl+A: add every photo matching the current filter/sort to the
   * selection (path=null → the whole working set, not just one group). Reuses
   * the same server select-all query as group select-all and export. */
  async function selectAllInView() {
    if (!displayEntries.length) return;
    try {
      const ids = await fetchPhotoIds(
        filterIsActive(displayFilter) ? displayFilter : null,
        null,
        sort
      );
      if (!ids.length) return;
      snapshotSelection(); // selecting everything can bury a careful selection too
      selectedIds = withIds(selectedIds, ids);
      status = `Selected ${selectedIds.size.toLocaleString()} photo${
        selectedIds.size === 1 ? "" : "s"
      } — Undo to restore`;
    } catch (e) {
      error = `Select all failed: ${e.message}`;
    }
  }

  // --- ⌘A / ⌘⇧A escalation (see lib/bulkSelection.js) -----------------------
  // Both act on the current group first, and only reach for everything the
  // filters show on a second press — which asks first, inline, because pulling
  // 10,000 photos into a selection on a keystroke is a surprise, not a feature.
  // `pendingBulk` is that question; pressing the same shortcut again answers it.
  /** @type {null|"select"|"deselect"} */
  let pendingBulk = $state(null);
  let pendingBulkCount = $derived(pendingBulk ? showingCount : 0);

  /** The pending "select this whole folder?" question (the threshold lives in
   * groupSelection.js). @type {null|{ids:number[], label:string}} */
  let pendingGroupSelect = $state(null);

  /** Every photo the filters currently show — the whole set, not just the
   * loaded window. The same server query select-all and export already use. */
  const fetchVisibleIds = () =>
    fetchPhotoIds(
      filterIsActive(displayFilter) ? displayFilter : null,
      null,
      sort
    );

  /** The ids of the group the focus is sitting in (empty when there's none). */
  async function currentGroupIds() {
    if (!currentPath || !currentPath.length) return [];
    return await fetchPhotoIds(null, currentPath, sort);
  }

  /** ⌘A. Group → (already have it) → ask → everything shown. */
  async function bulkSelect() {
    try {
      const ids = await currentGroupIds();
      const action = nextBulkAction("select", {
        pending: pendingBulk,
        hasGroup: ids.length > 0,
        groupFullySelected:
          ids.length > 0 && ids.every((id) => selectedIds.has(id)),
      });
      if (action === "group") {
        pendingBulk = null;
        snapshotSelection();
        selectedIds = withIds(selectedIds, ids);
        status = `Selected ${ids.length.toLocaleString()} in ${groupLabel(currentPath)} — ${combo("A")} again for all ${showingCount.toLocaleString()}`;
        return;
      }
      if (action === "prompt") {
        pendingBulk = "select";
        return; // the SelectionBar renders the question; no keystroke commits it
      }
      pendingBulk = null;
      await selectAllInView();
    } catch (e) {
      pendingBulk = null;
      error = `Select failed: ${e.message}`;
    }
  }

  /** ⌘⇧A. The mirror image: drop the group, then (asking first) everything shown. */
  async function bulkDeselect() {
    try {
      const ids = await currentGroupIds();
      const action = nextBulkAction("deselect", {
        pending: pendingBulk,
        hasGroup: ids.length > 0,
        groupHasSelection: ids.some((id) => selectedIds.has(id)),
      });
      if (action === "group") {
        pendingBulk = null;
        removeFromSelection(ids, groupLabel(currentPath));
        return;
      }
      if (action === "prompt") {
        pendingBulk = "deselect";
        return;
      }
      pendingBulk = null;
      removeFromSelection(await fetchVisibleIds(), "everything shown");
    } catch (e) {
      pendingBulk = null;
      error = `Deselect failed: ${e.message}`;
    }
  }

  /** Take ids out of the selection, stashing what left so Clear's Undo can put
   * it back — removing 10,000 photos from a selection must be recoverable. */
  function removeFromSelection(ids, what) {
    const removed = ids.filter((id) => selectedIds.has(id));
    if (!removed.length) return;
    snapshotSelection();
    selectedIds = withoutIds(selectedIds, removed);
    status = `Removed ${removed.length.toLocaleString()} photo${
      removed.length === 1 ? "" : "s"
    } from the selection (${what}) — Undo to restore`;
  }

  /** Answer the inline question with the mouse instead of the keyboard. */
  async function confirmPendingBulk() {
    const kind = pendingBulk;
    pendingBulk = null;
    if (kind === "select") await selectAllInView();
    else if (kind === "deselect")
      removeFromSelection(await fetchVisibleIds(), "everything shown");
  }

  /** The photo ids of a group. `paths` (a virtual folder ancestor's real
   * descendant groups) unions them: an ancestor like /L/Cards has no `folders`
   * row of its own, so scoping by equality on its path matches nothing — the
   * subtree IS the group. One path is the ordinary case and stays one request. */
  async function fetchGroupIds(path, paths) {
    const targets = paths?.length ? paths : [path];
    if (targets.length === 1) {
      return fetchPhotoIds(
        filterIsActive(displayFilter) ? displayFilter : null,
        targets[0],
        sort
      );
    }
    const lists = await Promise.all(
      targets.map((p) =>
        fetchPhotoIds(
          filterIsActive(displayFilter) ? displayFilter : null,
          p,
          sort
        )
      )
    );
    return [...new Set(lists.flat())];
  }

  /**
   * Click the group's select icon: take every photo in the group — and, for a
   * folder, everything in the folders UNDER it (see fetchGroupIds).
   *
   * Shift-click always REMOVES the group from the selection, whatever state it is
   * in, mirroring ⌘⇧A. Without it, clearing a partially-selected parent took two
   * clicks (one to fill it, one to empty it) and the first of those was the
   * opposite of what you wanted.
   *
   * A plain click on a fully-selected group still toggles it off, which is what
   * makes the checkbox read as a checkbox.
   */
  async function toggleGroupSelectAll(path, paths, event) {
    const key = pathKey(path);
    let entry = groupIdCache.get(key);
    if (!entry || entry.sig !== groupSelSig) {
      try {
        const ids = await fetchGroupIds(path, paths);
        entry = { ids, sig: groupSelSig };
        groupIdCache.set(key, entry);
        groupIdCacheVersion++;
      } catch (e) {
        error = e.message;
        return;
      }
    }
    const n = intersectionCount(entry.ids, selectedIds);
    const deselect =
      event?.shiftKey || selectState(n, entry.ids.length) === "all";

    if (deselect) {
      removeFromSelection(entry.ids, groupLabel(path));
      return;
    }
    // Taking a whole subtree is one click, and a big library makes that click
    // worth thousands of photos — easy to hit by accident on a parent you only
    // meant to look at. Ask, in the status bar, the same way ⌘A does (never a
    // blocking confirm() — see #97).
    if (needsSelectConfirm(entry.ids.length)) {
      pendingGroupSelect = { ids: entry.ids, label: groupLabel(path) };
      return;
    }
    applyGroupSelect(entry.ids, groupLabel(path));
  }

  /** Add a group's photos to the selection, undoably. */
  function applyGroupSelect(ids, label) {
    snapshotSelection();
    selectedIds = withIds(selectedIds, ids);
    status = `Selected ${ids.length.toLocaleString()} photo${
      ids.length === 1 ? "" : "s"
    } in ${label} — Undo to restore`;
  }

  /** Answer the "select this whole folder?" question. */
  function confirmPendingGroupSelect() {
    const p = pendingGroupSelect;
    pendingGroupSelect = null;
    if (p) applyGroupSelect(p.ids, p.label);
  }

  /** Remove an album (folder group) from the library index — a two-click
   * confirm because it drops the folder's photo rows AND their ratings from
   * SQLite (files on disk are untouched; a rescan re-adds the photos, unrated).
   * Only meaningful for a folder group; the button is gated on a folder leaf. */
  async function removeAlbum(path) {
    // Accept BOTH folder dims. isRemovableFolder() offers Remove for `folder`
    // AND `folderName` groups (they carry the same abs path server-side), but
    // this only looked for `folder` — so on a folderName group the button
    // rendered and did nothing at all. A silent no-op is exactly what we forbid.
    const folderPath = folderFromGroupPath(path);
    if (!folderPath) {
      error = "Can't remove this group — it isn't a folder.";
      return;
    }
    const key = pathKey(path);
    if (removeArmedKey !== key) {
      removeArmedKey = key; // first click arms the confirm
      return;
    }
    removeArmedKey = null;
    const name = folderPath.split(/[/\\]/).filter(Boolean).pop() || folderPath;
    try {
      status = `Removing ${name} from the library…`;
      const res = await removeFolderByPath(folderPath);
      collapsedPaths = collapsedPaths.filter((p) => pathKey(p) !== key);
      const nextSnaps = new Set(snapshotGroupKeys);
      nextSnaps.delete(key);
      snapshotGroupKeys = nextSnaps; // new ref — a $state Set isn't reactive in place
      // Full refresh (feed + sidebar tree + counts) — same as the Manage
      // Library remove path. `loadInitialFeed()` alone left the removed
      // folder lingering in the sidebar (it only refetches on libraryVersion).
      await onFolderRemoved();
      // Never a silent success: say what came out, and that the subtree went with
      // it, so removing a parent doesn't look like nothing happened.
      const f = res?.folders ?? 1;
      const p = res?.photos ?? 0;
      status =
        `Removed ${name} from the library — ` +
        `${f} folder${f === 1 ? "" : "s"}, ${p} photo${p === 1 ? "" : "s"}. ` +
        `Files on disk are untouched.`;
    } catch (e) {
      status = "";
      error = `Couldn't remove ${name}: ${e.message}`;
    }
  }

  // --- Rename a folder group in place (issue #68 Slice B) ------------------
  // Inline-edit the folder's section header; commit renames the real folder on
  // disk and reloads the feed. `renamingKey` is the pathKey being edited.
  let renamingKey = $state(null);
  let renameDraft = $state("");

  function startRename(path) {
    const folderPath = path?.find((p) => p.dimension === "folder")?.value;
    if (!folderPath) return;
    renamingKey = pathKey(path);
    renameDraft = folderPath.split("/").filter(Boolean).pop() || folderPath;
  }

  function cancelRename() {
    renamingKey = null;
    renameDraft = "";
  }

  async function commitRename(path) {
    const key = pathKey(path);
    if (renamingKey !== key) return; // already committed/canceled (blur re-entry)
    const folderPath = path?.find((p) => p.dimension === "folder")?.value;
    const name = renameDraft.trim();
    renamingKey = null; // close the editor immediately so blur can't re-fire this
    const current = folderPath
      ? folderPath.split("/").filter(Boolean).pop()
      : "";
    if (!folderPath || !name || name === current) return;
    try {
      const { newPath } = await renameFolder(folderPath, name);
      // A folder scope names the folder by path, so a rename must follow it —
      // no rebuild needed, the feed reloads right below.
      if (scope?.kind === "folder" && scope.path === folderPath)
        scope = folderScope(newPath);
      await loadInitialFeed();
      refreshCounts();
    } catch (e) {
      error = e.message;
    }
  }

  /**
   * Enter, replace, or leave the working scope (null = whole library). The ONE
   * rebuild path for both scope kinds — it routes through onGroupByChange (the
   * shared feed-window guard) rather than hand-rolling another window reset.
   * The two kinds are mutually exclusive by construction, so "keep only this
   * selection" while focused on a folder simply replaces the scope.
   * @param {import("./lib/scope.js").Scope} next
   */
  async function applyScope(next) {
    const wasIds = scope?.kind === "ids";
    const touchesFolder = next?.kind === "folder" || scope?.kind === "folder";
    try {
      // Push the id set to the server BEFORE any feed/tree/count query reads it,
      // and clear it when leaving an id scope so a stale keep_scope row can't
      // narrow the next query.
      if (next?.kind === "ids") await setScope(next.ids);
      else if (wasIds) await setScope([]);
    } catch (e) {
      error = e.message;
      return; // scope unchanged — the UI still matches what the server holds
    }
    scope = next;
    countsEpoch++;
    headerCounts = {};
    fetchedParents = new Set();
    inFlightParents = new Set();
    // displayFilter is a `$:` derived value keyed on `scope`; it hasn't
    // recomputed yet. Flush before rebuilding so the feed loader reads the new
    // filter — otherwise the rebuild fetches with the stale, unscoped filter and
    // the focus window's "before" half bleeds in the previous group's photos
    // (#75). Symmetric on exit, where the stale filter would still be scoped.
    await tick();
    await onGroupByChange(groupBy);
    refreshCounts();
    if (touchesFolder) libraryVersion++; // TreeSidebar/Fisheye refetch
  }

  /** Keep only the current selection as the working set. */
  function keepOnlySelection() {
    if (selectedIds.size === 0) return;
    applyScope(idsScope([...selectedIds]));
  }

  /**
   * Re-read the selected photos' metadata from disk (EXIF date, camera, lens,
   * dimensions), even though we have read them before — the file may have
   * changed, or an earlier read may have got it wrong. Runs as a cancelable job
   * so a big selection shows progress instead of freezing a button.
   *
   * Reloads the feed afterwards because a new date is not a cosmetic change: the
   * photo can move to a different day/year group entirely.
   */
  async function rereadSelection() {
    if (selectedIds.size === 0) return;
    rereading = true;
    error = "";
    try {
      const { jobId, pending } = await startEnrich([...selectedIds]);
      if (!jobId) {
        status = "Nothing to re-read";
        return;
      }
      status = `Re-reading metadata for ${pending.toLocaleString()} photo${pending === 1 ? "" : "s"}…`;
      const job = await waitForJob(jobId);
      if (job.status === "done") {
        const { read, failed } = job.result;
        status =
          `Re-read ${read.toLocaleString()} photo${read === 1 ? "" : "s"}` +
          (failed ? `, ${failed} unreadable` : "");
        await reloadAfterMetadata();
      } else if (job.status === "canceled") {
        status = "Re-read canceled";
        await reloadAfterMetadata(); // the ones we did finish still moved
      } else {
        error = job.error || "Re-reading metadata failed";
      }
    } catch (e) {
      error = `Re-reading metadata failed: ${e.message}`;
    } finally {
      rereading = false;
    }
  }

  /**
   * Read the metadata of every photo nobody has looked at yet. Enrichment is
   * lazy (only what you scroll past), so on a big library most photos have no
   * date and sit under "Unknown" — this is the button that goes and reads it all.
   */
  async function sweepMetadata() {
    sweeping = true;
    error = "";
    try {
      const { jobId, pending } = await startEnrich();
      if (!jobId) {
        status = "Every photo's metadata is already read";
        pendingMeta = 0;
        return;
      }
      status = `Reading metadata for ${pending.toLocaleString()} photos…`;
      const job = await waitForJob(jobId); // SSE-driven; a 100k sweep can take minutes
      if (job.status === "done") {
        const { read, failed } = job.result;
        status =
          `Read metadata for ${read.toLocaleString()} photos` +
          (failed ? `, ${failed} unreadable` : "");
      } else if (job.status === "canceled") {
        status =
          "Metadata read canceled — rerun it any time to pick up where it stopped";
      } else {
        error = job.error || "Reading metadata failed";
      }
      await reloadAfterMetadata();
    } catch (e) {
      error = `Reading metadata failed: ${e.message}`;
    } finally {
      sweeping = false;
    }
  }

  /** New dates/cameras mean photos change GROUPS — reload the feed, the counts
   *  and the tree, or the grid keeps showing them where they used to be. */
  async function reloadAfterMetadata() {
    await refreshPendingMeta();
    await onGroupByChange(groupBy);
    refreshCounts();
    libraryVersion++;
  }

  /** How many photos still have unread metadata (hides the button at 0). */
  async function refreshPendingMeta() {
    try {
      pendingMeta = await fetchPendingMeta();
    } catch {
      pendingMeta = 0; // a failed count must not break the panel
    }
  }

  /** How many indexed photos are missing from disk (drives the menu badge). */
  async function refreshMissingCount() {
    try {
      const { count } = await fetchMissing();
      missingCount = count;
    } catch {
      // A count is advisory; never surface its failure as a user error.
    }
  }

  /** After a review action (relocate/dismiss/carry) the library changed the same
   * way a folder removal does — refresh the count and the feed/tree together. */
  async function onMissingChanged() {
    await refreshMissingCount();
    await onFolderRemoved();
  }

  /** Nudge after a user-initiated folder scan that turned up missing files.
   * Uses `error` (not `status`) so the notice survives the feed reload that a
   * scan triggers; it is informational, not a failure. Shared by the three
   * scan-completion sites so the message stays identical. */
  async function reportScanMissing(job) {
    const m = job?.result?.missing;
    await refreshMissingCount();
    if (m && (m.toReview > 0 || m.autoRelocated > 0)) {
      const parts = [];
      if (m.toReview > 0)
        parts.push(
          `${m.toReview} file${m.toReview === 1 ? "" : "s"} went missing`
        );
      if (m.autoRelocated > 0) parts.push(`${m.autoRelocated} auto-relocated`);
      missingNotice = `${parts.join(", ")} — open “Review missing files” to sort them out`;
    }
  }

  /** Keep only one group/section (all its photos) as the working set. `paths`
   * scopes a virtual folder ancestor to its whole subtree — see fetchGroupIds. */
  async function keepOnlyGroup(path, paths) {
    if (!path || !path.length) return;
    try {
      const targets = paths?.length ? paths : [path];
      const lists = await Promise.all(
        targets.map((p) => fetchPhotoIds(null, p, sort))
      );
      const ids = [...new Set(lists.flat())];
      if (!ids.length) return;
      await applyScope(idsScope(ids));
    } catch (e) {
      error = e.message;
    }
  }

  /** Leave whatever scope is active, back to the whole library. */
  function exitScope() {
    applyScope(null);
  }

  /** Toggle one photo's membership in the selection. */
  function toggleSelect(id) {
    if (typeof id !== "number") return;
    selectedIds = toggleId(selectedIds, id);
  }

  /** Add every real photo between two displayEntries indices (inclusive) to
   * the selection — the shift-click range. Collapsed-stack entries contribute
   * their cover photo only. */
  function selectRange(a, b) {
    selectedIds = withIds(selectedIds, rangeIds(resolvedPhotos, a, b));
  }

  /** Grid tile click: Cmd/Ctrl toggles selection, Shift selects a range from
   * the focused tile, a plain click keeps the existing open/expand behavior. */
  // --- Right-click context menu (issue #18; shared surface for #25) ---------
  // `targetIndex` indexes displayEntries, like `selected`.
  let contextMenu = $state({ open: false, x: 0, y: 0, targetIndex: -1 });

  function openContextMenu(x, y, targetIndex) {
    contextMenu = { open: true, x, y, targetIndex };
  }

  function onTileContextMenu(e, entry, i) {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, i);
  }

  /** Reveal the photo at `index` in the OS file browser (Finder/Explorer/…). */
  async function reveal(index) {
    const it = resolvedPhotos[index];
    if (!it || typeof it.id !== "number") return;
    const res = await revealInFinder(it.id);
    if (!res.ok) {
      error = `Couldn't reveal file: ${res.error ?? "unknown error"}`;
      console.warn("[reveal]", res.error);
    }
  }

  /** Reveal the whole current selection in the OS file browser (best-effort per
   * platform — see /api/reveal-selection). */
  async function revealSelectionInFinder() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const res = await revealSelection(ids);
    if (!res.ok) {
      // `error`, not `status`: the next feed operation overwrites `status`, and
      // the server's 413 ("too many files… narrow the selection first") exists
      // precisely to be read and acted on.
      error = `Couldn't reveal selection: ${res.error ?? "unknown error"}`;
      console.warn("[reveal-selection]", res.error);
      return;
    }
    // Windows' Explorer can only highlight ONE file; the server says so rather
    // than pretending it revealed them all. Don't leave the user believing a
    // 30-file selection is sitting highlighted in Explorer.
    if (res.partial) {
      status = `Revealed 1 of ${ids.length} — ${res.partial}`;
    }
  }

  // Manual burst-stack actions (issue #24). All logic lives in
  // lib/stackActions.js + lib/stackOverrides.js; these two handlers just do the
  // toggleCover-style local-mutation-then-persist (no feed reload).
  async function onCreateStack(ids) {
    try {
      const { nextItems } = await createManualStackFromSelection(items, ids);
      items = nextItems;
    } catch (e) {
      error = e.message;
    }
  }
  async function onDissolveStack(memberIds) {
    try {
      const { nextItems } = await dissolveStackMembers(items, memberIds);
      items = nextItems;
    } catch (e) {
      error = e.message;
    }
  }

  // Menu items for the current target. Kept as data so actions can be appended
  // without reworking the menu component; the stack items are built by the module.
  let revealTargetId = $derived(resolvedPhotos[contextMenu.targetIndex]?.id);
  // Reveal the whole selection when the right-clicked photo is part of a
  // multi-selection (like a file manager); otherwise reveal just that photo.
  let revealWholeSelection = $derived(
    selectedIds.size > 1 &&
      typeof revealTargetId === "number" &&
      selectedIds.has(revealTargetId)
  );
  let contextMenuItems = $derived([
    {
      label: revealWholeSelection
        ? `Reveal ${selectedIds.size} photos in Finder`
        : "Reveal in Finder",
      action: () =>
        revealWholeSelection
          ? revealSelectionInFinder()
          : reveal(contextMenu.targetIndex),
      enabled: typeof revealTargetId === "number",
    },
    ...buildStackMenuItems({
      items,
      selectedIds,
      groupBy,
      displayEntries,
      targetIndex: contextMenu.targetIndex,
      stacks,
      onCreate: onCreateStack,
      onDissolve: onDissolveStack,
    }),
  ]);

  function onTileClick(e, entry, i) {
    if (e.metaKey || e.ctrlKey) {
      toggleSelect(resolvePhoto(entry)?.id);
      return;
    }
    if (e.shiftKey) {
      selectRange(selected, i);
      return;
    }
    if (entry.kind === "stack") {
      toggleExpand(entry.stack);
      return;
    }
    // Plain click on a photo: the first click just focuses (single-selects) it;
    // the loupe opens only when the tile is ALREADY the focused one — so a
    // second click, or a double-click (whose second click lands here with the
    // tile already focused), opens it. Lets you click through the grid to pick
    // a photo without the loupe taking over every time (issue #72).
    //
    // `focusIsExplicit` is what makes that true of the FIRST tile too: `selected`
    // starts at 0 so the keyboard has somewhere to begin, but the user hasn't
    // focused anything yet, and treating that as "already focused" made a single
    // click on photo #1 jump straight into the loupe — where rating auto-advances,
    // so every subsequent keystroke rated a different photo than the one on
    // screen (issue #104).
    if (selected === i && focusIsExplicit) openLoupe(i);
    else focusEntry(i);
  }

  /**
   * Clear the whole selection — undoable until the next clear replaces the stash.
   *
   * Deliberately NOT confirm()-guarded (#97). The clear is already recoverable:
   * it stashes the ids and SelectionBar shows an Undo button the moment there's
   * something to restore, which is the affordance CLAUDE.md asks for ("prefer
   * soft-delete + a visible undo over a hard action"). A native confirm() on top
   * of that made you answer a modal about something you could already take back —
   * and it froze the whole UI thread while it was up.
   */
  function clearSelection() {
    if (selectedIds.size === 0) return;
    const n = selectedIds.size;
    snapshotSelection();
    selectedIds = new Set();
    status = `Cleared ${n.toLocaleString()} photo${n === 1 ? "" : "s"} from the selection — Undo to restore`;
  }

  /**
   * Remember the selection as it is RIGHT NOW, so Undo can put exactly this back.
   * Called before every bulk change — Clear, ⌘A (group or everything), ⌘⇧A —
   * because any of them can wipe out a careful hand-picked selection, not just
   * the ones that remove. Single-photo toggles are not snapshotted: they're one
   * keystroke to reverse, and stashing on every X would make Undo mean "undo the
   * last thing" instead of "put my selection back".
   */
  function snapshotSelection() {
    lastClearedSelection = new Set(selectedIds);
  }

  /**
   * Restore the selection to EXACTLY what it was before the last bulk change.
   * This replaces the current selection rather than merging into it: the old
   * union meant undoing a select-all left you with the union of both, which is
   * not what "undo" says.
   */
  function undoClearSelection() {
    if (!lastClearedSelection) return;
    const n = lastClearedSelection.size;
    selectedIds = restoreSelection(lastClearedSelection);
    lastClearedSelection = null;
    status = n
      ? `Selection restored (${n.toLocaleString()} photo${n === 1 ? "" : "s"})`
      : "Selection restored (was empty)";
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
        move: exportMove,
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
      // Resolve a folder fallback from the first album photo when neither
      // focusPath nor the current groupBy grouping gives us one — album-
      // timeline photos carry no path of their own, so this is a one-off
      // lookup rather than something `currentFolder` can derive on its own.
      albumFirstPhotoFolder = null;
      if (!focusPath && !folderFromGroupPath(currentPath) && albumPhotos[0]) {
        try {
          const [meta] = await fetchMeta([albumPhotos[0].id]);
          albumFirstPhotoFolder = meta?.folder ?? null;
        } catch {
          /* non-fatal: currentFolder simply stays null */
        }
      }
      // Only the very first entry EVER (persisted) opens the setup modal
      // (explains how it works); later entries go straight to the review.
      albumAutoOpenSetup = localStorage.getItem(LS_ALBUM_SETUP_SEEN) !== "true";
      localStorage.setItem(LS_ALBUM_SETUP_SEEN, "true");
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
    // The whole index (and with it the scoped folder / the keep_scope rows) is
    // gone, so drop the scope outright rather than routing through applyScope —
    // this handler does its own full reload below.
    scope = null;
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
    await withFeedTransaction(async (epoch) => {
      const { items: page } = await fetchFeed({
        groupBy,
        collapsed: collapsedPaths,
        startPath: path,
        after: PAGE_SIZE,
        filter: displayFilter,
        sort,
      });
      if (epoch !== feedEpoch) return;
      // A jump lands mid-library at `path`; unlike loadInitialFeed (which starts
      // at the true top) there are almost always earlier groups above the target.
      // Seed hasMoreBefore=true so an upward scroll back-fills them (the "before"
      // loader seeks backward from the first loaded item). If we actually landed
      // on the very first group, that first before-fetch returns empty and
      // mergeFeedPage self-corrects hasMoreBefore back to false — one cheap probe.
      const merged = mergeFeedPage(
        { items: [], hasMoreBefore: true, hasMoreAfter: true },
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
      loupeOpen = false;

      // A FOLDED target (snapshot/collapsed) has no photos in the feed — it is a
      // single placeholder row. nextSelectable() skips placeholders, so it used
      // to silently focus the NEXT group's photos and the jump appeared to do
      // nothing. Land on the group's own row instead.
      const targetKey = pathKey(path);
      const folded = isServerCollapsed(
        rendererIdFor(path, collapsedKeys, snapshotGroupKeys)
      );
      if (folded) {
        await tick();
        const el = [
          ...(mainColumnEl?.querySelectorAll("[data-group-key]") ?? []),
        ].find((n) => n.dataset.groupKey === targetKey);
        if (el) {
          el.scrollIntoView({ block: "start" });
          status =
            "Jumped to the group (it's folded — click its icon to open).";
        } else {
          // Never fail silently: the group didn't make it into the window.
          error =
            "Couldn't jump to that group — it isn't in the loaded range. Open it (click its icon) and try again.";
        }
      } else {
        selected = nextSelectable(displayEntries, 0, 1) ?? 0;
        focusPending = true;
        status = `${items.length} photo${items.length === 1 ? "" : "s"} loaded`;
      }
      enrichMeta(page.map((i) => i.id));
    });
  }

  /** "Reveal current location": walks the tree down to whatever photo is
   * currently selected, expanding/fetching each level as needed. Manual,
   * not continuous — doesn't fight the tree's own navigation while the
   * user is mid-scroll or has it open to a different part of the library. */
  async function revealCurrentLocation() {
    const entry = displayEntries[selected];
    if (!entry || entry.kind === "placeholder") return;
    const photo = resolvePhoto(entry);
    // Primary action: bring the focused photo back into view (centered). Once the
    // feed scrolls, renderStart updates, so the fisheye + timeline "you are here"
    // markers follow on their own — no explicit fisheye reveal needed here.
    scrollSelectedIntoView();
    // Secondary: in tree mode, expand + highlight the photo's group path. (Fisheye
    // reflects the new position via its renderStart-driven marker above.)
    if (!photo?.groupValues) return;
    const path = groupBy
      .filter((d) => photo.groupValues[d] !== undefined)
      .map((d) => ({ dimension: d, value: photo.groupValues[d] }));
    treeSidebarRef?.revealPath(path);
  }

  /** Scroll the feed so the focused (`selected`) photo is centered. Uses the
   * layout model (`boxes`) rather than the DOM tile, so it works even when the
   * focus has been virtualized out of the render window (scrolled far away). */
  function scrollSelectedIntoView() {
    if (!gridEl || !mainColumnEl || !boxes) return;
    const b = boxes[selected];
    if (!b || b.y == null || b.height == null) return;
    const gridTop = gridEl.getBoundingClientRect().top + mainColumnEl.scrollTop;
    const target = Math.max(
      0,
      gridTop + b.y - (mainColumnEl.clientHeight - b.height) / 2
    );
    mainColumnEl.scrollTo({ top: target, behavior: "smooth" });
  }

  /** The group path at the "you are here" anchor (`hereIndex` — the focused
   * photo, or the first visible row when the focus is scrolled off) — drives the
   * fisheye dot + tree highlight so they follow both keyboard focus and scroll.
   * Read-only: derived from the existing render window, it never scrolls the feed
   * itself (honours issue #40's no-scroll-hijack rule). */
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
  // "You are here" anchor index. The markers (fisheye dot, tree highlight,
  // timeline tick) should point at the photo you're actually working on. During
  // keyboard culling that's the FOCUSED photo (`selected`) — it moves as you
  // arrow through the grid, often without scrolling, so a renderStart-only
  // anchor left the dot frozen (issue #18). When you mouse-scroll AWAY from the
  // focus (focus leaves the render window) we fall back to the first visible row
  // so the marker still follows the feed as you browse. Best of both.
  let hereIndex = $derived(
    selected >= renderStart && selected <= renderEnd ? selected : renderStart
  );
  let currentPath = $derived(
    deriveCurrentPath(hereIndex, displayEntries, groupBy)
  );

  // "You are here" in the sidebar tree — the SAME two anchors the timeline draws,
  // so the tree, the timeline and the fisheye all agree on where you are:
  //   • FOCUS — the photo you're working on (`selected`). Amber dot.
  //   • VIEW  — the group at the top of the feed viewport (`renderStart`). Eye.
  // treeKey strings so TreeNode can match by key. When the two land on the same
  // group, null out the view marker so the row shows just the amber focus dot —
  // exactly how the timeline collapses its coincident ticks (TimelineFilter).
  let focusHerePath = $derived(
    deriveCurrentPath(selected, displayEntries, groupBy)
  );
  let viewHerePath = $derived(
    deriveCurrentPath(renderStart, displayEntries, groupBy)
  );
  let focusHereKey = $derived(focusHerePath ? treeKey(focusHerePath) : null);
  let viewHereKey = $derived(viewHerePath ? treeKey(viewHerePath) : null);
  let viewHereKeyDistinct = $derived(
    viewHereKey && viewHereKey !== focusHereKey ? viewHereKey : null
  );

  // --- Scrubber landmark manifest ------------------------------------------
  // The right-edge rail reads one structural dataset: the ordered groups of the
  // current feed with their counts (reuse /api/tree/flat — the fisheye's source).
  // Fetched off (groupBy, sort, filter); the PREVIOUS manifest stays painted
  // until the new one arrives (morph-don't-blank on a sort/filter change). This
  // only ever reads — it never touches items/feedEpoch/the fetching flags, so it
  // sits entirely outside the feed-window transaction machinery.
  let scrubberManifest = $state(null);
  let scrubberSig = "";
  $effect(() => {
    const sig = JSON.stringify({ groupBy, sort, filter: displayFilter });
    if (sig === scrubberSig) return;
    scrubberSig = sig;
    const mine = sig;
    fetchFlatTree(groupBy, displayFilter, sort)
      .then((flat) => {
        if (mine !== scrubberSig) return; // a newer request superseded this one
        scrubberManifest = buildManifest(flat, { groupBy });
      })
      .catch(() => {}); // the rail is non-critical; never break the feed over it
  });

  // Thumb position: the top-visible group's coarsest-dim landmark start (group
  // granularity for v1 — see the design spec). viewportCount is a rough on-screen
  // entry count, enough to size a thin thumb.
  let scrubberTopCount = $derived.by(() => {
    const m = scrubberManifest;
    const coarseVal = viewHerePath?.[0]?.value;
    if (!m || coarseVal == null) return 0;
    const lm = m.landmarks.find((l) => l.value === coarseVal);
    return lm ? lm.startCount : 0;
  });
  let scrubberViewportCount = $derived(
    Math.max(0, renderEnd - renderStart + 1)
  );

  /** The abs folder path carried by a group path's "folder" or "folderName"
   * dimension, if present. Both dimensions carry the identical abs_path value
   * server-side (see dimensions.js/server/db/feed.js's DIMENSIONS) —
   * "folderName" only formats it down to a basename for display — so either
   * one found in `path` gives us the real folder. */
  function folderFromGroupPath(path) {
    if (!path) return null;
    const dim = path.find(
      (p) => p.dimension === "folder" || p.dimension === "folderName"
    );
    return dim ? dim.value : null;
  }
  /** The folder Auto-Albums' destination/naming should default to: the
   * focused folder if the user has one open, else the folder at the "you are
   * here" feed position (only meaningful when groupBy includes "folder" or
   * "folderName"), else the first album photo's own folder (resolved
   * asynchronously in detectAlbums, since album-timeline photos carry no
   * path). null when none of these resolve — never a stale remembered path. */
  let currentFolder = $derived(
    focusPath ||
      folderFromGroupPath(currentPath) ||
      albumFirstPhotoFolder ||
      null
  );
  let currentFolderName = $derived(
    currentFolder ? currentFolder.split(/[/\\]/).filter(Boolean).pop() : ""
  );

  /** Epoch-ms at the "you are here" anchor (`hereIndex` — the focused photo, or
   * the first visible row when the focus is scrolled off), for the timeline's
   * marker. Walks forward from the anchor to the first real (non-placeholder)
   * entry whose metadata has arrived (takenAt is filled by enrichMeta), so the
   * marker follows both keyboard focus and scroll. null until a timestamp is
   * known. */
  function deriveCurrentTime(start, entries, attr) {
    for (let i = Math.max(0, start); i < entries.length; i++) {
      const e = entries[i];
      if (!e || e.kind === "placeholder") continue;
      const t = photoDateFor(resolvePhoto(e), attr);
      if (t != null) return t;
    }
    return null;
  }
  // Two distinct timeline anchors, kept SEPARATE on purpose. The single merged
  // "you are here" tick used to wander on scroll because it conflated two ideas:
  //   • FOCUS — the photo you're working on (`selected`). Stays put as you scroll.
  //   • VIEW  — the first row currently on screen (`renderStart`). Moves on scroll.
  // The timeline now draws both (an eye tick for view, an amber tick for focus), so
  // scrolling the feed never makes your focused photo's marker drift. Pass dateAttr
  // so both recompute when the sort date changes, not just on scroll (Svelte only
  // tracks deps named in the reactive expression).
  let focusTime = $derived(
    deriveCurrentTime(selected, displayEntries, filter.dateAttr)
  );
  let viewTime = $derived(
    deriveCurrentTime(renderStart, displayEntries, filter.dateAttr)
  );
  // The markers follow the loaded feed window (`displayEntries`), which is rebuilt
  // asynchronously on each filter change, while the selection band follows `filter`
  // synchronously. During rapid brushing the window lags the band, which would
  // paint a marker OUTSIDE the selection until the feed catches up. In display mode
  // the feed is narrowed to the range, so a marker outside it is a stale-window
  // artifact — suppress it until the feed reconciles (state-driven, no settle
  // timer). In select mode the grid spans the whole library, so a marker outside
  // the (sub-range) selection is legitimate and stays visible. `mode`/`f` are named
  // params so Svelte re-clamps when filterMode/filter change, not just the time.
  function clampMarker(t, mode, f) {
    if (t == null) return null;
    if (mode === "select") return t;
    if (f.dateFrom != null && t < f.dateFrom) return null;
    if (f.dateTo != null && t > f.dateTo) return null;
    return t;
  }
  let focusMarkerTime = $derived(clampMarker(focusTime, filterMode, filter));
  let viewMarkerTime = $derived(clampMarker(viewTime, filterMode, filter));

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
  async function recenterFeedOnId(
    focusId,
    { collapsed = collapsedPaths } = {}
  ) {
    return withFeedTransaction(
      async (epoch) => {
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
          ? dedupeById([
              ...beforePage,
              ...(focusItem ? [focusItem] : []),
              ...afterPage,
            ])
          : afterPage;
        hasMoreBefore = focusId ? beforePage.length >= PAGE_SIZE / 2 : false;
        hasMoreAfter =
          afterPage.length >= (focusId ? PAGE_SIZE / 2 : PAGE_SIZE);
        await tick();
        selected = resolveSelectedIndex(displayEntries, focusId);
        focusPending = true;
        status = `${items.length} photo${items.length === 1 ? "" : "s"} loaded`;
        enrichMeta(items.map((i) => i.id));
        return selected;
      },
      { onError: -1 }
    );
  }

  /** Toggle a section's collapsed state and re-center the feed on whatever
   * photo is currently selected, so the user doesn't lose their place —
   * mirrors onGroupByChange's re-centering. */
  /** The id of a group's first photo in the current sort (null if the group
   * has no photos under the active filter). Seeks to the group's own top via
   * startPath so an expand loads the group from its BEGINNING and paginates
   * downward. safeFocusId(selected) can't do this: the collapsed group is a
   * single placeholder with no real photo id, so it resolves to the NEXT
   * group's first photo, and recentering there loads only this group's tail
   * (the reported "doesn't expand all the photos" — #74). Must run AFTER the
   * group is removed from collapsedPaths, so the server returns its real photos
   * rather than the placeholder. */
  async function firstPhotoIdOfGroup(path) {
    const { items: head } = await fetchFeed({
      groupBy,
      collapsed: collapsedPaths,
      startPath: path,
      after: 1,
      filter: displayFilter,
      sort,
    });
    return head[0]?.id ?? null;
  }

  /**
   * The entry index where `path`'s group starts in the current window, or -1.
   * The group you clicked is the thing to anchor the refetch on — `selected` can
   * be anywhere (it's the FOCUSED tile, and a user who has only scrolled hasn't
   * focused anything, so it sits at 0, at the top of the library).
   */
  function firstEntryIndexOfPath(path) {
    const key = pathKey(path);
    for (let i = 0; i < displayEntries.length; i++) {
      const e = displayEntries[i];
      if (!e) continue;
      if (e.kind === "placeholder") {
        if (pathKey(e.item.path) === key) return i;
        continue;
      }
      const p = deriveCurrentPath(i, displayEntries, groupBy);
      if (p && pathKey(p) === key) return i;
    }
    return -1;
  }

  async function toggleSectionCollapse(path) {
    const key = pathKey(path);
    const collapsing = !collapsedPaths.some((p) => pathKey(p) === key);
    // Hold this group's header where it is across the refetch, in BOTH
    // directions. Arm the pin BEFORE the refetch — recenterFeedOnId sets
    // focusPending, whose focus() would otherwise scroll to `selected`; the
    // pin's presence turns that scroll off (preventScroll) and holds the header
    // in place instead (issue #74). Collapsing needs it just as much: you were
    // looking at this group when you clicked it.
    const offset = groupAnchorOffset(key);
    expandPin = offset == null ? null : { key, offset };

    collapsedPaths = collapsing
      ? [...collapsedPaths, path]
      : collapsedPaths.filter((p) => pathKey(p) !== key);

    // Both directions seek from THIS GROUP, never from `selected`.
    //
    // Collapse used to re-center on safeFocusId(selected, …). But `selected` is
    // the focused tile, and a user who has only scrolled has never focused
    // anything — it's photo 0. So collapsing a group far down the feed reloaded
    // the window from the TOP of the library: the view jumped, and the group you
    // just clicked fell outside the loaded window, so its placeholder never
    // arrived and the snapshot band you asked for never rendered. Anchoring on
    // the group keeps it inside the window, which is the whole point of clicking
    // it. (Falls back to `selected` when the group isn't in the window at all.)
    const anchorIndex = firstEntryIndexOfPath(path);
    const focusId = collapsing
      ? safeFocusId(anchorIndex >= 0 ? anchorIndex : selected, path)
      : ((await firstPhotoIdOfGroup(path)) ?? safeFocusId(selected));
    await recenterFeedOnId(focusId);
    if (expandPin) {
      await tick();
      pinExpandNow();
    }
  }

  /** Which group labels offer "Remove from library". A group is a real folder on
   * disk whether it's keyed by `folder` (the full path) or `folderName` (the
   * leaf) — Remove was only offered for the former, so grouping by folderName
   * hid it for no good reason. */
  const REMOVABLE_FOLDER_DIMS = new Set(["folder", "folderName"]);
  function isRemovableFolder(path) {
    return REMOVABLE_FOLDER_DIMS.has(path?.at(-1)?.dimension);
  }

  // Watch the backend. If it dies or restarts (a crash, or `node --watch`
  // reloading it after a server edit), ServerBanner says so and we refetch once
  // it's back — instead of silently sitting on data from a server that's gone.
  let seenRestart = 0; // plain guard (edge-detect; never read reactively)
  startServerWatchdog();
  // Reads the $serverRestarted store (tracked) + seenRestart (plain guard);
  // writes only the plain guard, so it can't loop.
  $effect(() => {
    if ($serverRestarted > seenRestart) {
      seenRestart = $serverRestarted;
      onServerBack();
    }
  });
  async function onServerBack() {
    try {
      libraryVersion++; // sidebars refetch
      await refreshCounts();
      // Reload AROUND the photo you were on, not from the top. loadInitialFeed()
      // resets `selected` to the first item — and with `node --watch` the server
      // now restarts on every backend edit, so that teleported you out of
      // whatever you were culling. Every other rebuild path (sort/filter/groupBy)
      // uses recenterFeedOnId for exactly this reason.
      const focusId = safeFocusId(selected);
      if (focusId != null) await recenterFeedOnId(focusId);
      else await loadInitialFeed();
      status = "Reconnected to the server — reloaded.";
    } catch (e) {
      error = `Reconnected, but reloading failed: ${e.message}`;
    }
  }

  /** The catch-all the UI never had: anything that escapes a try/catch — an
   * uncaught error while rendering, or a rejected promise nobody awaited — gets
   * SHOWN, not just logged. Keeps the "a console error is not user feedback"
   * rule true even for bugs we didn't anticipate. Deduped so a render loop can't
   * spam the status line. */
  // Dedupe only within a short window: keyed forever, a recurring error the user
  // had already dismissed could never be surfaced again (L6).
  let lastUncaught = "";
  let lastUncaughtAt = 0;
  const UNCAUGHT_DEDUPE_MS = 4000;
  function reportUncaught(kind, err) {
    const msg = err?.message ?? String(err ?? "unknown error");
    const now = performance.now();
    if (msg === lastUncaught && now - lastUncaughtAt < UNCAUGHT_DEDUPE_MS)
      return;
    lastUncaught = msg;
    lastUncaughtAt = now;
    error = `Something broke while ${kind === "display" ? "drawing the view" : "finishing a background task"}: ${msg} — reload the window, or undo the last change (grouping / collapse / filter).`;
    console.error(`[uncaught:${kind}]`, err);
  }

  /** A group label's ‹/› buttons: jump to the group before/after THIS one. We
   * anchor on this group's edge photo in the travel direction so the server's
   * boundary seek steps out of the group instead of hopping inside it — the UI
   * equivalent of Option+←/→, but independent of where the keyboard focus is. */
  async function jumpFromGroup(path, direction) {
    if (jumpingGroup) return;
    let ids;
    try {
      // Only the boundary photo is needed — don't drag every id of a 10k folder
      // across the wire to read one of them.
      ids = await fetchPhotoIds(
        filterIsActive(displayFilter) ? displayFilter : null,
        path,
        sort,
        direction === "next" ? "last" : "first"
      );
    } catch (e) {
      error = `Couldn't jump: ${e.message}`;
      return;
    }
    if (!ids.length) return;
    await jumpGroupBoundary(direction, ids[0]);
  }

  /**
   * THE single place that answers "which widget draws this group's photos?".
   * Every read — the header icon, the layout's band height, the band's component,
   * the tree sidebar — goes through here, so the two legacy structures behind it
   * (collapsedPaths + snapshotGroupKeys) can be collapsed into one Map without
   * touching any caller. See docs/superpowers/specs/2026-07-12-group-photo-renderers.md
   * and issue #100.
   *
   * `_collapsed`/`_snapshots` are taken as ARGS (not closed over) so Svelte's
   * dependency tracking — which reads the expression's source text — actually
   * re-runs this in the template when either changes.
   * @returns {string} a GROUP_RENDERERS id
   */
  function rendererIdFor(path, _collapsedKeys, _snapshots) {
    const key = pathKey(path);
    if (!_collapsedKeys.has(key)) return "grid";
    return _snapshots.has(key) ? "snapshot" : "collapsed";
  }

  // --- Folder labels ---------------------------------------------------------
  // Folder names are mostly redundancy — the year the parent already states, the
  // _peq on every folder in the library. folderLabel.js decides which tokens earn
  // a pixel; the corpus is the whole library (not the filtered view), so a label
  // never changes shape as you filter or scroll. The tree sidebar is handed the
  // same stats, so a folder reads the same in both places.
  let folderPaths = $derived(library.map((entry) => entry.path));
  let tokenStats = $derived(buildTokenStats(folderPaths));
  let siblingIndex = $derived(buildSiblingIndex(folderPaths));
  // The same roots the tree draws. A header drops everything ABOVE its own root
  // ("/Users/me/Pictures") and keeps the root itself ("backup/…"), so it
  // still says which library it belongs to. Stripping a single library-wide
  // ancestor can't work once folders live on more than one volume — they share
  // only "/" — and then every header would render its full absolute path and get
  // cut at the tail, losing the very part that names the group.
  let libraryRoots = $derived(
    buildFolderTree(folderPaths.map((value) => ({ value, count: 0 })))
  );
  function headerPrefixFor(value) {
    const root = libraryRoots.find(
      (r) => value === r.value || value.startsWith(`${r.value}/`)
    );
    return root ? dirname(root.value) : "";
  }

  /** A folder section header, as display parts.
   *
   * Unlike a tree row, a header stands alone — there is no parent row above it to
   * supply context — so it keeps its whole path. The same rule runs over all of
   * it, path segments included: the prefix every folder shares is on 100% of the
   * library, so it recedes on its own, while a directory that is genuinely rare
   * stays bright. The siblings that decide what's redundant are the folders that
   * actually share this one's parent on disk — not whatever happens to be in the
   * feed window — so a header never changes shape as you scroll. */
  function folderHeaderParts(value) {
    const siblings = siblingIndex.get(dirname(value)) ?? [];
    return labelParts(relativeTo(value, headerPrefixFor(value)), {
      stats: tokenStats,
      siblings,
    });
  }

  /** Is this group a folder on disk? Both folder dims count — the icon, and the
   *  actions it advertises, apply to either. */
  function isFolderDim(header) {
    return REMOVABLE_FOLDER_DIMS.has(header?.path?.at(-1)?.dimension);
  }

  // --- The tree's right-click menu -------------------------------------------
  // A SECOND menu state, not a reuse of `contextMenu`: that one is keyed by
  // targetIndex (a photo in displayEntries) and this one by a group path, and
  // folding both into one object means every item has to re-derive which kind it
  // is. Both render through the same ContextMenu component — the surface is
  // shared, the state is not.
  let treeMenu = $state({ open: false, x: 0, y: 0, items: [] });
  /** The folder a Remove is waiting on confirmation for (null = no dialog). */
  let removeFolderPending = $state(null);

  function openTreeMenu(detail) {
    treeMenu = {
      open: true,
      x: detail.x,
      y: detail.y,
      items: buildTreeMenuItems({
        path: detail.path,
        folderPath: detail.folderPath,
        isVirtual: detail.isVirtual,
        isFolder: detail.isFolder,
        hasChildren: detail.hasChildren,
        expanded: detail.expanded,
        rendererId: detail.rendererId,
        canJump: !!detail.jumpPath,
        on: {
          jump: () => detail.jumpPath && jumpToPath(detail.jumpPath),
          // Over the SUBTREE, not just this folder — the same thing the feed
          // header's checkbox does. (It has to be, or the tree and the feed would
          // disagree about what "select this folder" means. A virtual ancestor
          // owns no photos at all, so for it the subtree is the only answer.)
          selectAll: () => toggleGroupSelectAll(detail.path, detail.groupPaths),
          keepOnly: () =>
            keepOnlyGroup(
              detail.path,
              detail.isVirtual ? detail.groupPaths : undefined
            ),
          cycleView: () =>
            detail.isVirtual
              ? cycleLeafPaths(detail.groupPaths)
              : cycleGroupState(detail.path),
          // expandedKeys is TreeSidebar's own state, so the sidebar handed us a
          // closure rather than us reaching into it.
          toggleDescendants: detail.toggleDescendants,
          reveal: () => revealFolderInFinder(detail.folderPath),
          copyPath: () => copyFolderPath(detail.folderPath),
          rescan: () => rescanFolder(detail.folderPath),
          // ContextMenu closes on every action, so the two-click "arm" that the
          // group header uses cannot survive in here — the confirm has to outlive
          // the menu. A modal does.
          remove: () => (removeFolderPending = detail),
        },
      }),
    };
  }

  /** Right-click on a FEED section header opens the SAME menu the tree offers,
   * built from the header's own group path via the shared buildTreeMenuItems +
   * openTreeMenu path. The feed has no tree-expand concept, so the "expand/
   * collapse sub-folders" item is omitted (hasChildren:false); everything else —
   * jump, select-all, keep-only, the grid/snapshot/collapse view-cycle, and (for
   * folder groups) Reveal/Copy path/Rescan/Remove — is identical to the tree's,
   * so the two surfaces can never disagree about what a group action means. (#126)
   */
  function openHeaderMenu(e, header) {
    if (!header?.path) return;
    e.preventDefault();
    const folderPath = folderFromGroupPath(header.path);
    openTreeMenu({
      x: e.clientX,
      y: e.clientY,
      path: header.path,
      groupPaths: header.groupPaths,
      folderPath,
      isVirtual: !!header.isVirtual,
      isFolder: !!folderPath,
      hasChildren: false,
      expanded: false,
      rendererId: rendererIdFor(header.path, collapsedKeys, snapshotGroupKeys),
      jumpPath: header.path,
    });
  }

  async function revealFolderInFinder(folderPath) {
    if (!folderPath) return;
    const name = folderPath.split(/[/\\]/).filter(Boolean).pop() || folderPath;
    const res = await revealFolder(folderPath);
    if (!res.ok) {
      error = `Couldn't reveal that folder: ${res.error ?? "unknown error"}`;
    } else {
      // Never a silent success: the Finder window may open behind the app, so say
      // it happened in the status bar too.
      status = `Revealed ${name} in Finder`;
    }
  }

  /** Copy a folder's path to the clipboard. The first clipboard use in the app —
   * and it can reject (a non-secure context, or the user denying permission), so
   * it says so rather than failing into the void. */
  async function copyFolderPath(folderPath) {
    if (!folderPath) return;
    try {
      await navigator.clipboard.writeText(folderPath);
      status = "Path copied";
    } catch (e) {
      error = `Couldn't copy the path: ${e?.message ?? e}. Select it from the row's tooltip instead.`;
    }
  }

  /** Re-scan one folder — picks up whatever changed on disk since the last scan
   * (files added, removed or edited in Finder). Recursive, so a card's whole
   * subtree catches up in one go, and it runs as a cancelable background job so
   * the JobsPanel shows progress instead of the UI freezing. Reuses doScan by
   * pointing it at this folder, rather than growing a second scan path that
   * would drift from it. */
  async function rescanFolder(folderPath) {
    if (!folderPath || scanning) return;
    // Deliberately NOT routed through doScan: that reads the Add panel's own
    // state (`dir`, `recursiveScan`, the subfolder picker), so driving it from
    // here would mean writing to bound inputs — the folder path would appear in
    // the Add box, and the panel's "last folder" would be overwritten, as a side
    // effect of a menu click. It runs the same job and the same refresh.
    error = "";
    scanning = true;
    status = `Rescanning ${folderPath.split("/").filter(Boolean).at(-1)}…`;
    try {
      const { jobId } = await startScan(folderPath, { recursive: true });
      const job = await waitForJob(jobId, onScanProgress);
      if (job.status === "canceled") {
        status = "Rescan canceled";
        return;
      }
      if (job.status !== "done") {
        error = job.error || "Rescan failed";
        status = "";
        return;
      }
      refreshLibrary();
      // The folder's photo set may have changed anywhere in the current sort, so
      // reload rather than trying to patch the window (same reasoning as doScan).
      await loadInitialFeed();
      refreshCounts();
      libraryVersion++; // the tree/fisheye refetch
      await reportScanMissing(job);
    } catch (e) {
      error = `Couldn't rescan that folder: ${e?.message ?? e}`;
      status = "";
    } finally {
      scanning = false;
    }
  }

  async function confirmRemoveFolder() {
    const detail = removeFolderPending;
    removeFolderPending = null;
    if (!detail) return;
    // removeAlbum is the same handler the group header uses, and it arms on the
    // first call — the modal IS the confirmation, so prime the arm and call it.
    removeArmedKey = pathKey(detail.path);
    await removeAlbum(detail.path);
  }

  /** Header parts for any dimension: only folders need the treatment.
   *
   * `_stats` / `_roots` are unused INSIDE the function — they are there so the
   * template's call site names them, and Svelte re-runs the each-block when they
   * change. Svelte's reactivity tracks the variables an expression MENTIONS, not
   * what the called function closes over: without them, headers rendered before
   * /api/library resolved kept an empty corpus forever, printing the whole
   * absolute path with nothing dimmed. (TreeNode.svelte carries a comment about
   * the same trap for collapsedPaths.) */
  function headerParts(header, _stats, _roots) {
    // A NESTED folder row already says where it sits, so it shows only its own
    // name (or the merged "a/b/c" chain of a unary run) — not the whole path.
    // Same labelParts treatment the tree gives it, against its real on-disk
    // siblings, so one folder reads identically in the feed and in the sidebar.
    if (header.nested) {
      return labelParts(header.label, {
        stats: tokenStats,
        siblings: siblingIndex.get(dirname(header.value)) ?? [],
      });
    }
    return header.path?.at(-1)?.dimension === "folder"
      ? folderHeaderParts(header.path.at(-1).value)
      : [{ text: header.label, kind: "keep" }];
  }

  /** Svelte action: fade the clipped edge only when something IS hidden behind it.
   * The header shows the END of the path (see .section-label), so what overflows
   * is on the left — and CSS can't measure that, hence the class. `_parts` is here
   * so the call site names it and the action re-measures when the label changes. */
  function tailClip(el, _parts) {
    const mark = () =>
      el.parentElement?.classList.toggle(
        "clipped",
        el.scrollWidth > el.parentElement.clientWidth
      );
    mark();
    return { update: mark };
  }

  /** Tooltip for the group toggle, from the registry (no parallel string table:
   *  a new renderer must not need a second edit somewhere else). */
  function groupToggleTitle(rendererId) {
    const now = getRenderer(rendererId);
    const then = getRenderer(nextRendererId(rendererId));
    return `${now.label} — click for ${then.label.toLowerCase()}`;
  }

  /** Feed group tri-state: expanded → snapshot → collapsed → expanded.
   * snapshot is a server-collapsed group the client renders as a strip. */
  async function cycleGroupState(path) {
    // A path with a missing level would poison collapsedPaths and blank the feed
    // (the undefined value crashed formatGroupValue). Refuse it, loudly.
    if (
      !Array.isArray(path) ||
      !path.length ||
      path.some((p) => p?.value == null)
    ) {
      error =
        "Couldn't collapse that group — its grouping values are incomplete. Try a different grouping.";
      return;
    }
    const current = rendererIdFor(path, collapsedKeys, snapshotGroupKeys);
    await setGroupRenderer(path, nextRendererId(current));
  }

  /**
   * THE single writer of a group's renderer — the counterpart to rendererIdFor().
   *
   * Everything derives from the registry descriptor: whether the group must be
   * collapsed SERVER-side comes from `needsFeedPhotos`, never from a hand-kept
   * list. collapsedPaths + snapshotGroupKeys are now an implementation detail of
   * this one function, which is what makes the Map migration in issue #100 a
   * local change rather than a 24-site rewrite.
   */
  async function setGroupRenderer(path, rendererId) {
    beginFold();
    const key = pathKey(path);
    const wasCollapsed = collapsedKeys.has(key);
    const nowCollapsed = isServerCollapsed(rendererId);

    // A parent's renderer SUPERSEDES its descendants' — otherwise a leaf that was
    // already snapshotted keeps its own entry and the feed draws a second strip
    // inside the parent's one.
    collapsedPaths = collapsedPaths.filter(
      (p) => !isPathUnder(p, path) || pathKey(p) === key
    );
    const snaps = new Set(
      [...snapshotGroupKeys].filter((k) => !isKeyUnder(k, path) || k === key)
    );
    if (rendererId === SNAPSHOT_ID) snaps.add(key);
    else snaps.delete(key);
    snapshotGroupKeys = snaps;

    // Only touch the server when the group's "does the feed stream its photos"
    // answer actually flips; a snapshot→collapsed change is client-side only.
    if (nowCollapsed !== wasCollapsed) await toggleSectionCollapse(path);

    endFold();
  }

  /**
   * The snapshot strip UNFURLS in place: it opens from exactly the spot, and at
   * exactly the photo size, that the group's first row of photos occupied, while
   * the photos below glide up (that glide is Thumb's own transition, and predates
   * this). Together they read as the grid folding shut, rather than as photos
   * blinking out and an unrelated widget blinking in.
   *
   * `folding` is why this doesn't misfire. The feed is VIRTUALIZED: a band scrolled
   * out of view is destroyed and re-created when you come back, and an unguarded
   * entry animation would replay the unfurl every single time a snapshot group came
   * back on screen. The animation runs only while a fold is actually landing.
   *
   * A fold has THREE writers, and all three have to say so — setGroupRenderer (one
   * group), cycleLeafPaths (a virtual ancestor, or a Shift-click, folding its
   * leaves) and cycleAllGroups (the whole feed). Hooking only the first is how this
   * came to be written twice: the fixture's first header is a virtual ancestor, so
   * the animation never fired at all in the one place it was being tested.
   */
  const FOLD_MS = 260;
  let folding = $state(false);
  let foldTimer = null; // plain timer handle

  /** Halve nothing for someone who has asked the OS not to animate things. */
  let foldMs = $derived(
    folding && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ? FOLD_MS
      : 0
  );

  function beginFold() {
    clearTimeout(foldTimer);
    folding = true;
  }

  /** Called once the new layout is actually ON SCREEN — a fold that has to ask the
   *  server for a new feed window lands whenever it lands, so the clock starts when
   *  the strip appears, not when the click happened. The timeout is the animation's
   *  own length; it is not a guess at how long anything takes to settle. */
  async function endFold() {
    await tick();
    clearTimeout(foldTimer);
    foldTimer = setTimeout(() => (folding = false), FOLD_MS);
  }

  // --- Shift+click a parent = fold its LEAVES (VS Code function folding) -----
  // Plain click on a parent aggregates it (collapse/snapshot the parent as one
  // block). Shift+click instead applies the state to every LEAF underneath, so
  // the parent stays open and you see its subgroups as folded rows.
  // `isPathUnder`/`isKeyUnder` (the shared subtree test the three fold writers
  // rely on) live in lib/foldPaths.js.
  const MAX_FOLD_LEAVES = 400;

  /** Every LEAF group path under `parent` (a path of full groupBy depth). */
  async function collectLeafPaths(parent) {
    let frontier = [parent];
    for (let depth = parent.length; depth < groupBy.length; depth++) {
      const next = [];
      for (const p of frontier) {
        const { nodes } = await fetchTreeNode({
          groupBy,
          path: p,
          filter: displayFilter,
          sort,
        });
        for (const n of nodes) {
          next.push([...p, { dimension: groupBy[depth], value: n.value }]);
        }
        if (next.length > MAX_FOLD_LEAVES) return next; // bail early, caller checks
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return frontier;
  }

  // A shift-fold walks the hierarchy with one tree fetch per internal node. That
  // can take seconds on a deep/large library, and a second click mid-traversal
  // would interleave two of them. Guard it, and SAY it's working (CLAUDE.md: a
  // long operation must show progress, not a frozen control).
  let foldingLeaves = false;

  /** Shift+click on a group with subgroups: cycle ALL of its leaves together. */
  async function cycleGroupLeaves(path) {
    if (path.length >= groupBy.length) return cycleGroupState(path); // already a leaf
    if (foldingLeaves) return;
    foldingLeaves = true;
    status = "Folding subgroups…";
    let leaves;
    try {
      leaves = await collectLeafPaths(path);
    } catch (e) {
      error = `Couldn't fold the subgroups: ${e.message}`;
      return;
    } finally {
      foldingLeaves = false;
    }
    if (!leaves.length) return cycleGroupState(path); // nothing beneath → aggregate
    return cycleLeafPaths(leaves, {
      // Clear any state anywhere inside this subtree — including the parent's own
      // aggregate collapse — before applying the new one to the leaves.
      insidePath: (p) => isPathUnder(p, path),
      insideKey: (k) => isKeyUnder(k, path),
    });
  }

  /** Cycle a SET of groups as one: the shared state math behind shift-folding a
   * subgroup and behind the tree's folder rows (a folder row can stand for every
   * folder beneath it, and a virtual ancestor has no state of its own at all).
   * `insidePath`/`insideKey` say what counts as "inside" the thing being folded —
   * a group subtree for one caller, an explicit list of folders for the other. */
  async function cycleLeafPaths(leaves, { insidePath, insideKey } = {}) {
    if (!leaves.length) return;
    if (leaves.length > MAX_FOLD_LEAVES) {
      error = `That group has more than ${MAX_FOLD_LEAVES} subgroups — too many to fold at once. Collapse it as a whole instead (click without Shift).`;
      return;
    }
    const leafKeys = new Set(leaves.map(pathKey));
    const isInsidePath = insidePath ?? ((p) => leafKeys.has(pathKey(p)));
    const isInsideKey = insideKey ?? ((k) => leafKeys.has(k));

    // Next state, from where the leaves collectively are now (all-expanded →
    // snapshot → collapsed → expanded). A mixed set resets to expanded.
    const states = leaves.map((lp) =>
      rendererIdFor(lp, collapsedKeys, snapshotGroupKeys)
    );
    // Uniform leaves advance together through the registry's cycle; a mixed set
    // resets to the default. Works for any number of renderers.
    const uniform = states.every((x) => x === states[0]);
    const next = uniform ? nextRendererId(states[0]) : DEFAULT_RENDERER_ID;

    const nextCollapsed = collapsedPaths.filter((p) => !isInsidePath(p));
    const nextSnaps = new Set(
      [...snapshotGroupKeys].filter((k) => !isInsideKey(k))
    );
    if (isServerCollapsed(next)) {
      for (const lp of leaves) {
        nextCollapsed.push(lp);
        if (next === SNAPSHOT_ID) nextSnaps.add(pathKey(lp));
      }
    }
    beginFold();
    collapsedPaths = nextCollapsed;
    snapshotGroupKeys = nextSnaps;
    try {
      await loadInitialFeed();
    } catch (e) {
      error = e.message;
    } finally {
      endFold();
    }
  }

  /** Entry point for every group toggle (feed header + tree icon): Shift folds
   * the leaves, a plain click aggregates the group itself.
   *
   * `paths` arrives from the tree when a row speaks for more than one group — a
   * folder row that has sub-folders beneath it, or a virtual ancestor that has no
   * group of its own. Those cycle together. */
  function onGroupToggle(path, event, paths) {
    if (paths?.length) return cycleLeafPaths(paths);
    return event?.shiftKey ? cycleGroupLeaves(path) : cycleGroupState(path);
  }

  /** Set collapsedPaths / snapshotGroupKeys so EVERY current top-level group
   * matches `mode`: "expanded" clears both; "snapshot"/"collapsed" collapse all
   * top-level groups (snapshot also renders each as a strip). Fetches the current
   * top-level group list under displayFilter. Does NOT rebuild the feed — the
   * caller reloads after. Reused by the cycle-all control AND by filter/sort
   * rebuilds so a global view mode survives those changes (new groups inherit it). */
  async function applyViewModeToGroups(mode) {
    if (!isServerCollapsed(mode)) {
      collapsedPaths = [];
      snapshotGroupKeys = new Set();
      return;
    }
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
      mode === SNAPSHOT_ID ? new Set(allPaths.map(pathKey)) : new Set();
  }

  /** The top-of-toolbar "cycle all" control: flip EVERY top-level group at
   * once through full view → snapshot all → collapse all → full view. Sets
   * collapsedPaths / snapshotGroupKeys wholesale and rebuilds the feed from the top. */
  async function cycleAllGroups() {
    if (cyclingAll) return;
    const next = nextRendererId(globalViewMode);
    cyclingAll = true;
    beginFold();
    try {
      await applyViewModeToGroups(next);
      globalViewMode = next;
      await loadInitialFeed();
    } catch (e) {
      error = e.message;
    } finally {
      cyclingAll = false;
      endFold();
    }
  }

  /** The rendered grid tile for a photo id, or null when it isn't in the DOM
   * (virtualized out, or not yet mounted). The single home for the
   * `gridEl.querySelector('[data-id=...]')` lookup that reveal, the group-jump
   * pin, and the focus helpers all shared verbatim (issue #42 Step 2). Callers
   * pass `resolvePhoto(entry).id` — a collapsed stack's data-id is its cover
   * photo's raw id, not the stack id, so entryDomId would miss. */
  function tileEl(id) {
    return id == null
      ? null
      : (gridEl?.querySelector(`[data-id="${id}"]`) ?? null);
  }

  /** Give roving keyboard focus to a photo id's grid tile, if it's rendered.
   * `preventScroll` keeps the browser's native focus-scroll from fighting our
   * own reveal/pin scrolling (issue #74); no-op when the tile isn't in the DOM.
   *
   * Never steals the keyboard from a text field. Every feed reload ends in a
   * refocus, and a search keystroke IS a feed reload — so this used to rip the
   * caret out of the search box mid-word, sending the rest of what you typed to
   * the grid, where digits rate photos. */
  function focusTile(id, { preventScroll = false } = {}) {
    if (isTypingTarget(document.activeElement)) return;
    tileEl(id)?.focus({ preventScroll });
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
    tileEl(id)?.scrollIntoView({ block, inline: "nearest" });
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
    const tile = tileEl(id);
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

  /** The current viewport offset (px below the scroll container's top) of a
   * group's on-screen anchor — its collapsed pill/snapshot row when folded, or
   * its (non-sticky) `.section-wrapper` when expanded. Both carry the group's
   * `pathKey` as `data-group-key`; whichever exists is the group's true start
   * position (the sticky `.section-header` inside the wrapper is NOT it — it
   * detaches and rides the top edge). Returns null if neither is mounted.
   * getBoundingClientRect forces a synchronous layout, so this reads the real
   * position even mid-reflow. Matching is done in JS, not a CSS selector, since
   * pathKey is JSON (embedded quotes/brackets would break an attribute
   * selector). */
  function groupAnchorOffset(key) {
    if (!gridEl || !mainColumnEl) return null;
    const el = [...gridEl.querySelectorAll("[data-group-key]")].find(
      (n) => n.dataset.groupKey === key
    );
    if (!el) return null;
    return (
      el.getBoundingClientRect().top - mainColumnEl.getBoundingClientRect().top
    );
  }

  /** Hold the just-expanded group's header at its captured pre-expand offset —
   * the expand analogue of pinNow. Same reflow story as a group-jump: the
   * refetch rebuilds the feed window and metadata then re-justifies the rows,
   * so a single scroll can't hold the header; the `boxes` reactive re-asserts
   * this until the user takes over. */
  function pinExpandNow() {
    if (!expandPin) return;
    const current = groupAnchorOffset(expandPin.key);
    if (current == null) return;
    const delta = current - expandPin.offset;
    if (Math.abs(delta) > 0.5) {
      const max = mainColumnEl.scrollHeight - mainColumnEl.clientHeight;
      mainColumnEl.scrollTop = Math.max(
        0,
        Math.min(max, mainColumnEl.scrollTop + delta)
      );
    }
  }

  function scheduleExpandPin() {
    tick().then(() => {
      if (expandPin) pinExpandNow();
    });
  }

  /** Give roving keyboard focus to the currently-selected tile's DOM element,
   * without letting the browser's native focus-scroll fight revealSelected
   * (preventScroll). Shared by keyboard nav and group-jump. */
  function focusSelectedTile() {
    const entry = displayEntries[selected];
    focusTile(entry ? resolvePhoto(entry).id : null, { preventScroll: true });
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

  async function loadMore(direction, afterSize = PAGE_SIZE) {
    // Only "after" scales (forward scroll is where the user out-runs the
    // loader); "before" keeps a fixed page so its scroll-compensation math stays
    // simple. Clamp to [PAGE_SIZE, PAGE_SIZE_MAX] and use the SAME number for the
    // fetch and mergeFeedPage's hasMore test.
    const afterPage =
      direction === "after"
        ? Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE, Math.round(afterSize)))
        : PAGE_SIZE;
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
        after: direction === "after" ? afterPage : 0,
        filter: displayFilter,
        sort,
      });
      if (epoch !== feedEpoch) return;
      const merged = mergeFeedPage(
        { items, hasMoreBefore, hasMoreAfter },
        { items: page },
        direction,
        direction === "after" ? afterPage : PAGE_SIZE
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
          it.duration = m.duration ?? null; // video length → grid badge
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

  // An undo-move (from the JobsPanel Undo button) is a fire-and-forget
  // background job with no completion callback: the server moves the files
  // back and repoints the index, but the client only learns it finished via
  // the SSE-backed `jobs` store. Watch that store and run the full refresh
  // (sidebar tree + feed + counts) once per undo-move job as it reaches a
  // terminal state — otherwise the sidebar keeps showing the moved-away
  // folders. Edge-detected via `handledUndoJobs` so it fires exactly once.
  let handledUndoJobs = new Set(); // plain edge-detect set
  // Reads the $jobs store (tracked); handledUndoJobs is a plain set mutated
  // inside takeNewlyFinished, so this effect fires only when $jobs changes and
  // cannot loop on its own writes.
  $effect(() => {
    if (takeNewlyFinished($jobs, "undo-move", handledUndoJobs).length) {
      onFolderRemoved();
    }
  });

  /** After AlbumsView materializes (move/copy) album folders to disk, scan
   * the destination so the newly-created nested folders index and show up
   * in the sidebar tree right away, instead of waiting for the user to
   * manually rescan. Exits Auto Albums back to the normal feed once the
   * scan/refresh settles (success or failure) so the rescanned tree is
   * visible — the album-review view has nothing left to show once its
   * source photos have been moved/copied out. */
  async function onAlbumsMaterialized({ destParent }) {
    if (!destParent) return;
    try {
      status = "indexing new albums…";
      const { jobId } = await startScan(destParent, { recursive: true });
      const job = await waitForJob(jobId);
      if (job.status === "canceled") {
        status = "Scan canceled";
        return;
      }
      if (job.status !== "done") {
        error = job.error || "Rescan of materialized albums failed";
        status = "";
        return;
      }
      await refreshLibrary();
      libraryVersion++;
      status = "";
      await reportScanMissing(job);
    } catch (e) {
      error = e.message;
      status = "";
    } finally {
      albumMode = false;
    }
  }

  /** How many newly-indexed photos are worth re-reading the feed for, while a
   *  scan is still running. Bounds the cost: one extra feed page per 200 photos
   *  scanned, not one per photo. */
  const SCAN_REFRESH_STEP = 200;
  let scanRefreshAt = 0;
  let scanRefreshing = false;

  /**
   * Show photos AS they are indexed, instead of staring at an empty grid until
   * the whole disk walk finishes ("the grid appears while scanning continues" —
   * the founding perf thesis; the server has streamed this progress all along
   * and the client simply awaited the end of the job).
   *
   * Only while the feed is still empty. A scan that ADDS a folder to a library
   * you are already browsing must not reload the grid under your cursor — there,
   * the one refresh at the end is both correct and less rude.
   */
  function onScanProgress(job) {
    if (items.length) return; // you're browsing — don't yank the feed
    if (scanRefreshing) return; // one in flight is enough
    if (!crossedStep(scanRefreshAt, job.done ?? 0, SCAN_REFRESH_STEP)) return;
    scanRefreshAt = job.done ?? 0;
    scanRefreshing = true;
    loadInitialFeed()
      .catch(() => {}) // a mid-scan refresh that misses is not a user-facing failure; the final load still runs
      .finally(() => {
        scanRefreshing = false;
      });
  }

  /** @returns {Promise<boolean>} true when the folder is indexed and the feed
   * has caught up — the caller (submitAddFolder) needs to know whether it may
   * scope to the folder afterwards. Renders its own error on every failure. */
  async function doScan() {
    scanRefreshAt = 0;
    if (!dir.trim()) return false;
    error = "";
    missingNotice = ""; // a new scan supersedes any previous missing-file nudge
    scanning = true;
    status = "scanning…";
    let scanJob = null;
    try {
      if (recursiveScan) {
        // Recursive ("soup folder") scans run as a cancelable background
        // job — live progress shows in the JobsPanel. Single-folder scan
        // stays synchronous below (fast; returns items for immediate render).
        // `chosen` is the curated subfolder subset, or null when the user never
        // opened the picker (then the server walks the whole tree, as always).
        const chosen =
          subdirsOpen && subdirs.length
            ? selectedDirs(subdirSelection, subdirs)
            : null;
        const { jobId } = await startScan(dir.trim(), {
          recursive: true,
          dirs: chosen,
        });
        const job = await waitForJob(jobId, onScanProgress);
        if (job.status === "canceled") {
          status = "Scan canceled";
          return false;
        }
        if (job.status !== "done") {
          error = job.error || "Scan failed";
          status = "";
          return false;
        }
        scanJob = job;
      } else {
        const body = await apiScan(dir.trim(), false);
        scanJob = { result: body };
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
      if (scanJob) await reportScanMissing(scanJob);
      return true;
    } catch (e) {
      error = e.message;
      status = "";
      return false;
    } finally {
      scanning = false;
    }
  }

  /**
   * The Add panel's one submit — adding, opening, and rescanning a folder are
   * the same act with different options. Three outcomes:
   *
   *   already indexed + focus  → scope to it, NO scan. This is what lets you
   *                              open a folder with its drive unmounted: the
   *                              SQLite index is an offline mirror, and an
   *                              unmounted volume can't be rescanned anyway.
   *   already indexed, no focus→ incremental rescan, to catch up with disk.
   *   new folder               → scan it in, then scope to it if asked.
   */
  async function submitAddFolder() {
    const p = dir.trim();
    if (!p) return;
    addFolderOpen = false;
    error = "";
    if (alreadyIndexed && focusAfterAdd) {
      await applyScope(folderScope(p));
      return;
    }
    const ok = await doScan(); // renders its own error when it fails
    if (ok && focusAfterAdd) await applyScope(folderScope(p));
  }

  /** The native picker fills the path in and leaves the panel open — it does NOT
   * scan. Scanning straight out of the picker would make every option in this
   * panel (which subfolders to import, whether to focus) unreachable for anyone
   * with a native picker, i.e. the packaged app: the scan would already be
   * running by the time the panel came back. The user commits with the button. */
  async function chooseFolder() {
    const path = await window.autogallery?.pickFolder();
    if (!path) return;
    dir = path;
    addFolderOpen = true;
  }

  // Flickr-style justified layout via the pure module in lib/layouts/ —
  // aspect ratios in, positioned boxes out. Absolutely-positioned children
  // ignore CSS padding, so the frame inset is applied to the box coordinates.
  const PAD = 12;
  // One nesting step, shared by the layout (photo indent) and the CSS (header
  // indent + dendrogram trunk), so the lines and the photos agree.
  const GROUP_INDENT = 18;
  const HEADER_HEIGHT = 32;
  const PLACEHOLDER_HEIGHT = 40; // a bit taller than a header — needs room for an icon, label, and count on one line
  /* Sticky headers stack, outermost on top, so each level sits one BELOW the
     last: z = base - depth. The old base of 15 went NEGATIVE past depth 15 —
     unreachable while depth was capped by groupBy.length, trivially reachable
     now that a folder chain nests inside one groupBy slot. Everything here
     resolves inside .grid's own stacking context (isolation: isolate), so this
     scale is private and cannot collide with the topbar's z-index. The
     dendrogram trunk sits at base + 1, above every header. */
  const Z_HEADER_BASE = 1000;

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

  let autoStacks = $derived(
    detectBurstsByGroup(items, groupBy, {
      gapMs: burstEnabled ? burstGapMs : 0,
    })
  );
  // Fold in the persisted manual create/dissolve overrides (issue #24) — all
  // logic lives in ui/src/lib/stackOverrides.js; this is the only stacks change.
  let stacks = $derived(applyStackOverrides(autoStacks, items));
  let displayEntries = $derived(
    buildDisplayEntries(items, stacks, expandedStackIds)
  );
  let resolvedPhotos = $derived(displayEntries.map(resolvePhoto)); // passed to Loupe
  let stackById = $derived(new Map(stacks.map((s) => [s.id, s])));
  // Per-photo burst tag, 1:1 with resolvedPhotos, so the loupe filmstrip can draw
  // bursts EXACTLY the way the grid does (via the shared BurstOverlay): a
  // collapsed cover shows a ×N badge and is click-to-expand; the members of an
  // expanded burst show the ⚏ marker (gold on the cover) and are click-to-collapse
  // (#127). Each tag carries the stackId so those controls can call back into
  // toggleExpand/collapseStack.
  let loupeBurstInfo = $derived(
    displayEntries.map((e) =>
      e.kind === "stack"
        ? { count: e.stack.count, stackId: e.stack.id }
        : e.kind === "photo" && e.stackId
          ? {
              member: true,
              stackId: e.stackId,
              isCover: e.item.id === stackById.get(e.stackId)?.coverId,
            }
          : null
    )
  );
  // The loupe filmstrip's expand/collapse control routes here, reusing the feed's
  // own stack toggle so the loupe and grid stay in lock-step: expanding sets
  // `selected` to the cover (toggleExpand → focusEntry), so the loupe follows.
  function loupeToggleBurst(stackId) {
    const stack = stacks.find((s) => s.id === stackId);
    if (stack) toggleExpand(stack); // toggleExpand already folds both ways
  }
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
  // Every group ALWAYS gets exactly one header — even when a non-grid renderer
  // draws its photos. suppressPlaceholderHeaders() used to delete a collapsed
  // group's own header so the pill/strip could show a duplicate label of its own;
  // that's what made the snapshot ignore the header's indentation. See
  // docs/superpowers/specs/2026-07-12-group-photo-renderers.md (invariant 1).
  //
  // Then nestFolderHeaders turns the flat folder groups into the folder SUBTREE
  // — the same one the sidebar draws (same compaction, same virtual ancestors,
  // same rolled-up counts, because it is literally the same folderTree.js). A
  // header comes out carrying BOTH depths: `depth` (its groupBy index, which the
  // path/count logic keys off) and `visualDepth` (how deep it sits in the folder
  // tree, which the layout and the dendrogram draw). Conflating those two is the
  // bug this split exists to prevent — see lib/folderSections.js.
  let rootsByParentKey = $derived(
    new Map(
      [...folderNodesByParentKey].map(([key, nodes]) => [
        key,
        buildFolderTree(nodes),
      ])
    )
  );
  let sectionHeaders = $derived(
    nestFolderHeaders(
      computeHeaderPaths(deriveSectionHeaders(resolvedPhotos, groupBy)),
      { groupBy, rootsByParentKey }
    )
  );
  // Fetch each visible group's total photo count, one query per *parent*
  // path (the tree API returns every sibling's count in a single GROUP BY),
  // caching so scrolling — which recomputes sectionHeaders on every window
  // change — refetches nothing already known. Runs whenever the header set
  // changes; almost every run is a no-op once a region's counts are cached.
  // (loadHeaderCounts writes headerCounts/folderNodesByParentKey only AFTER an
  // await, and the dedup Sets it reads/writes synchronously — fetchedParents /
  // inFlightParents — are plain, so this effect never loops.)
  $effect(() => {
    loadHeaderCounts(sectionHeaders, groupBy, countsEpoch);
  });

  async function loadHeaderCounts(headers, groupByAtCall, epoch) {
    for (const parent of headerParentPaths(headers)) {
      const key = pathKey(parent);
      if (fetchedParents.has(key) || inFlightParents.has(key)) continue;
      inFlightParents.add(key);
      let node;
      try {
        node = await fetchTreeNode({
          groupBy: groupByAtCall,
          path: parent,
          filter: displayFilter,
          sort,
        });
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
      // This response IS the folder level — every folder under `parent`, with its
      // count, in one GROUP BY. Keep it: the feed's folder trie (and therefore
      // every virtual ancestor and every rolled-up count) is built from exactly
      // this, so nesting the feed costs no request of its own.
      if (dimension === "folder" || dimension === "folderName") {
        folderNodesByParentKey = new Map(folderNodesByParentKey).set(
          key,
          node.nodes
        );
      }
    }
  }
  let layoutResult = $derived(
    displayEntries.length && gridWidth > 2 * PAD
      ? sectionedJustifiedLayout(
          displayEntries.map((e) => {
            if (e.kind === "placeholder") {
              // The band under the header is the RENDERER's, and its height must
              // be known before anything mounts (the feed is virtualized).
              const r = getRenderer(
                rendererIdFor(e.item.path, collapsedKeys, snapshotGroupKeys)
              );
              return {
                id: entryDomId(e),
                placeholder: true,
                height: r.bandHeight({
                  snapshotRowHeight,
                }),
              };
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
          // The layout nests on `depth`, and it is already fully depth-generic
          // (closeAtOrBelow / currentIndent assume nothing about groupBy) — so
          // handing it `visualDepth` AS `depth` is the whole integration, and
          // sectionedJustified.js needs no change at all. Downstream (the header
          // template) therefore reads header.depth = the visual one, which is
          // exactly what the indent, the sticky offset and the trunk want.
          sectionHeaders.map((h) => ({ ...h, depth: h.visualDepth })),
          {
            containerWidth: gridWidth - 2 * PAD,
            gap: gridGap,
            targetRowHeight: rowHeight,
            headerHeight: HEADER_HEIGHT,
            placeholderHeight: PLACEHOLDER_HEIGHT,
            // Nest the CONTENT, not just the header: photos of a sub-group are
            // inset to sit under their own header. Same step as the header
            // indent (--ind) so the dendrogram lines up with the photos.
            indentPerDepth: GROUP_INDENT,
          }
        )
      : null
  );
  let boxes = $derived(layoutResult ? layoutResult.boxes : null);
  // How far below the scroll viewport's top a revealed tile should sit: one
  // sticky-header band per grouping level, plus a PAD of breathing room. Used
  // both as the tile's CSS scroll-margin-top (--reveal-margin) and by the
  // jump-landing pin below.
  // Every ancestor stays pinned, so the sticky stack is as tall as the DEEPEST
  // nesting on screen — which, with folder subtrees, is no longer bounded by
  // groupBy.length (a folder chain can be several rows deep inside one groupBy
  // slot). Measure it instead of assuming it.
  let stickyDepth = $derived(
    sectionHeaders.length
      ? 1 + Math.max(...sectionHeaders.map((h) => h.visualDepth))
      : groupBy.length
  );
  let revealMargin = $derived(HEADER_HEIGHT * stickyDepth + PAD);
  // Re-pin the group-jump landing on every LAYOUT recompute while pinned, not
  // just on grid-height change (the ResizeObserver's blind spot): a metadata
  // reflow can shrink the rows above the landing while others grow, leaving
  // total grid height ~unchanged — so the observer never fires, yet the
  // landing slides up off the top. `boxes` is a fresh array on every layout
  // recompute, so this fires for exactly those reflows. tick() (a microtask,
  // unlike rAF) defers to just after Svelte patches the DOM, so pinNow reads
  // the tile's final position — and works even in a backgrounded tab.
  $effect(() => {
    if (jumpRevealPending && boxes) scheduleJumpPin();
  });
  // Same re-pin story for an expanded group's header (see expandPin): the
  // refetch + metadata reflow keep moving it until the layout settles.
  $effect(() => {
    if (expandPin && boxes) scheduleExpandPin();
  });
  // Scroll anchor: keep the user's eye-point fixed across a layout recompute.
  // `boxes` is a fresh array on every recompute (metadata streaming in, resize,
  // zoom); when the anchor tile — the one that was at the top of the viewport —
  // lands at a new grid-local y, shift scrollTop by exactly that delta so nothing
  // under the user's gaze moves. Depends ONLY on `boxes` (the rest is untracked),
  // so it fires per-recompute, not on scroll (scroll never rebuilds boxes).
  // Yields to every mechanism that legitimately OWNS scroll: a full window
  // replace (focusPending — it re-centers on the selected photo by design and
  // clears the anchor), the group-jump / expand pins (they re-pin scrollTop
  // themselves, above), and loadMore's own prepend compensation
  // (fetchingBefore/After). What remains is exactly the uncompensated, jumpy set.
  // Only touches scrollTop — never items / feedEpoch / the fetching flags — so it
  // stays entirely outside the feed-window transaction machinery.
  $effect(() => {
    if (!boxes) return;
    untrack(() => {
      if (!layoutAnchor || !mainColumnEl) return;
      if (
        focusPending ||
        jumpRevealPending ||
        expandPin ||
        fetchingBefore ||
        fetchingAfter
      )
        return;
      const anchor = layoutAnchor;
      const nb = boxes.find((b) => b.id === anchor.domId);
      if (!nb || nb.y === anchor.y) return;
      mainColumnEl.scrollTop = anchorScrollTop(
        mainColumnEl.scrollTop,
        anchor.y,
        nb.y
      );
      // Chain across back-to-back reflows before the next scroll re-captures.
      layoutAnchor = { domId: anchor.domId, y: nb.y };
    });
  });
  // Scroll runway kept BELOW the loaded content while more remains, so a fast
  // fling scrolls into empty space instead of clamping at the loaded content's
  // floor and stopping ("quick flings get stopped because it thinks I reached
  // the end"). Bounded — loadMore backfills it as the user descends. Shares the
  // adaptivePageSize switch (both keep the loader ahead of a fast scroll).
  const BOTTOM_RESERVE_PX = 3000;
  let gridHeight = $derived(
    layoutResult
      ? scrollableHeight(layoutResult.totalHeight, {
          pad: PAD,
          hasMoreAfter: adaptivePageSize && hasMoreAfter,
          reservePx: BOTTOM_RESERVE_PX,
        })
      : 0
  );
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
  // MUST be `$effect.pre`, not `$effect`: it writes `renderStart`/`renderEnd`,
  // which `visibleItems` (below) derives and the grid `{#each}` reads. A plain
  // `$effect` runs AFTER the DOM updates, so a fold/filter that shortened `boxes`
  // would render the OLD visible range against the NEW, shorter `boxes` — and
  // `boxes[i]` is then undefined for a stale index (crash: reading 'y'/'kind').
  // The Svelte-4 `$:` ran in dependency order BEFORE render; `$effect.pre` +
  // lazy `$derived` restores exactly that: the range is refreshed before
  // `visibleItems` is pulled for the DOM.
  $effect.pre(() => {
    if (boxes) {
      // Depend ONLY on `boxes` (matching the Svelte-4 `$:`): untrack the body so
      // updateVisibleRange → loadMore's SYNCHRONOUS reads (items, selected, the
      // fetching flags) don't become effect dependencies and re-fire this on
      // every feed mutation — and so loadMore's synchronous `fetchingAfter =
      // true` write can never re-enter this effect (a Svelte-4 `$:` tracked only
      // `boxes`; runes' dynamic tracking would otherwise widen that).
      untrack(() => {
        updateVisibleRange();
        tick().then(() => requestAnimationFrame(updateVisibleRange));
      });
    }
  });
  let visibleItems = $derived(
    buildVisibleItems(displayEntries, renderStart, renderEnd, selected)
  );

  // First scan of a session: bind:clientWidth's initial value arrives
  // asynchronously (Svelte's iframe resize-listener fires on iframe.onload),
  // so `boxes` may still be null right after doScan sets focusPending. Defer
  // the post-scan focus until `boxes` — and therefore the selected Thumb —
  // actually exists; this also covers rescans, where `boxes` is already
  // truthy and this fires immediately.
  // Reads focusPending + boxes; writes focusPending = false. The write flips the
  // condition false, so the one re-run this schedules is a no-op — it converges
  // (this is the documented reseed pattern, not an infinite loop).
  $effect(() => {
    if (focusPending && boxes) {
      focusPending = false;
      // A window replace re-centers on the selected photo by design — any anchor
      // captured against the OLD window is stale and must not fight that jump.
      layoutAnchor = null;
      tick().then(() => {
        // Thumb's data-id attribute is always the resolved photo's raw id
        // (Thumb only ever receives `item`, never the display entry), so DOM
        // lookups must key on resolvePhoto(entry).id, not entryDomId(entry) —
        // entryDomId is the stack id for a collapsed stack and never appears
        // in the DOM as a data-id.
        const entry = displayEntries[selected];
        // preventScroll while a group is being expanded: focusing the selected
        // tile must not yank the viewport off the header the expand pin is holding
        // (issue #74). Normal scans/jumps (no pin) keep the focus-reveal scroll.
        focusTile(entry ? resolvePhoto(entry).id : null, {
          preventScroll: !!expandPin,
        });
      });
    }
  });

  /**
   * Rate a photo optimistically, and PUT THE STAR BACK if the write fails.
   *
   * The optimistic update is what makes culling feel instant, but on its own it
   * lies: a failed write used to leave the star lit, so you would keep culling
   * against a rating the database never took, and the export would ship the
   * wrong set. Silent data loss, wearing the UI of success. Reverting is the
   * whole point — the message alone is not enough, because a status line you
   * scroll past does not un-light a star.
   */
  function rate(index, rating) {
    const entry = displayEntries[index];
    if (!entry) return;
    const it = resolvePhoto(entry);
    if (!it) return;
    const previous = it.rating;
    it.rating = rating;
    items = items; // trigger reactivity
    apiSetRating(it.id, rating).catch((e) => {
      // Re-find by id: the feed window may have been replaced while the request
      // was in flight, in which case `it` is an orphan and writing to it would
      // revert nothing the user can see.
      const current = items.find((i) => i.id === it.id);
      if (current) current.rating = previous;
      items = items;
      error = `Rating not saved (${e.message}) — the star was put back.`;
    });
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
        const previous = it.preferredCover;
        it.preferredCover = shouldBeCover;
        // Same contract as rate(): a write that failed must not leave the UI
        // claiming it succeeded (see rate()).
        apiSetCover(it.id, shouldBeCover).catch((e) => {
          const current = items.find((i) => i.id === id);
          if (current) current.preferredCover = previous;
          items = items;
          error = `Cover not saved (${e.message}) — the stack's cover was put back.`;
        });
      }
    }
    items = items; // trigger reactivity
  }

  function openLoupe(index) {
    focusEntry(index);
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
  /** The group's view state at the moment the loupe was opened from it — a
   * snapshot strip, or a collapsed row — so closing the loupe puts it back
   * instead of leaving the group expanded behind you.
   * @type {null|{path: Array<{dimension:string,value:string}>, rendererId: string}} */
  let loupeRestore = null;

  async function openPhotoById(id, groupPath = null) {
    // NOTE: we intentionally do NOT exit album mode here. When you click a photo
    // in the Auto-albums snapshot strips, the loupe opens as an overlay on top
    // of the still-mounted AlbumsView; pressing Esc closes the loupe and returns
    // you to the album review with all your split/naming/materialize state
    // intact (previously this set albumMode=false, unmounting AlbumsView and
    // discarding that work — the in-feed redesign in #81 supersedes this).
    // Opening a photo has to EXPAND the group it lives in: a snapshot (or
    // collapsed) group is collapsed server-side, so its photos aren't in the feed
    // window at all and there is nothing to open. But that expansion was
    // permanent — click a photo in a strip, press Esc, and you were dropped into
    // the group's full grid instead of back into the strip you were looking at.
    // Remember what it was, and put it back when the loupe closes.
    if (groupPath) {
      const key = pathKey(groupPath);
      const was = rendererIdFor(groupPath, collapsedKeys, snapshotGroupKeys);
      loupeRestore =
        was === DEFAULT_RENDERER_ID
          ? null
          : { path: groupPath, rendererId: was };
      collapsedPaths = collapsedPaths.filter((p) => pathKey(p) !== key);
      const nextSnaps = new Set(snapshotGroupKeys);
      nextSnaps.delete(key);
      snapshotGroupKeys = nextSnaps; // new ref — a $state Set isn't reactive in place
    } else {
      loupeRestore = null;
      collapsedPaths = [];
      snapshotGroupKeys = new Set();
    }
    await recenterFeedOnId(id);
    const idx = findEntryIndexForId(displayEntries, id);
    if (idx !== -1) openLoupe(idx);
  }

  async function closeLoupe() {
    loupeOpen = false;

    // Back to the view you came from. Restoring BEFORE the focus/scroll below is
    // deliberate: re-collapsing the group changes the feed, so focusing first
    // would scroll to a tile that is about to stop existing.
    if (loupeRestore) {
      const { path, rendererId } = loupeRestore;
      loupeRestore = null;
      await setGroupRenderer(path, rendererId);
    }

    await tick();
    // Return focus to the grid, scrolled to the current item. (Key on
    // resolvePhoto(entry).id, matching Thumb's data-id — see focusPending.)
    const entry = displayEntries[selected];
    focusTile(entry ? resolvePhoto(entry).id : null);
  }

  /** Re-collapse a stack: remove it from expandedStackIds, then re-select
   * and re-focus its now-collapsed tile once displayEntries recomputes. */
  async function collapseStack(stackId) {
    // Reassign a NEW Set — a `$state` Set is NOT deeply reactive (unlike arrays/
    // objects), so `.delete()` + self-assign is a no-op that never re-runs the
    // displayEntries derived; only a fresh reference triggers it.
    const next = new Set(expandedStackIds);
    next.delete(stackId);
    expandedStackIds = next;
    await tick();
    const newIndex = displayEntries.findIndex(
      (e) => e.kind === "stack" && e.stack.id === stackId
    );
    if (newIndex !== -1) {
      focusEntry(newIndex);
      await tick();
      // The re-collapsed tile resolves to its cover photo, so its data-id
      // is the cover's raw id, not stackId — see focusPending's comment.
      const entry = displayEntries[newIndex];
      focusTile(resolvePhoto(entry).id, { preventScroll: true });
    }
  }

  /** Expand a stack: every member appears individually, tagged with the
   * stack id, until collapseStack() is called (Escape, in onKeydown). */
  async function toggleExpand(stack) {
    if (expandedStackIds.has(stack.id)) {
      await collapseStack(stack.id);
      return;
    }
    // New Set, not `.add()` + self-assign: a `$state` Set isn't deeply reactive,
    // so mutating in place never re-runs the displayEntries derived (this is why
    // clicking a burst stopped expanding it after the Svelte 5 migration).
    expandedStackIds = new Set(expandedStackIds).add(stack.id);
    await tick();
    const newIndex = displayEntries.findIndex(
      (e) => e.kind === "photo" && e.item.id === stack.coverId
    );
    if (newIndex !== -1) {
      focusEntry(newIndex);
      await tick();
      focusTile(stack.coverId, { preventScroll: true });
    }
  }

  /** Recompute [renderStart, renderEnd] from the grid's current position,
   * and trigger a fetch-more in either direction when the render window
   * is near a loaded edge. */
  // --- Predictive thumbnail prefetch --------------------------------------
  // Warm the browser cache for tiles just beyond the viewport in the direction
  // of travel, scaled to scroll velocity, so a fast scroll paints from cache
  // instead of a cold fetch ("the album loading is slower than I can scroll").
  // Thumbnails are served immutable (Cache-Control: 1yr), so a bare `new Image()`
  // populates the HTTP cache and the real tile then hits Thumb's synchronous
  // detectCache fast path. Warms BYTES ONLY for ids already in the loaded window
  // — never calls loadMore or touches items/feedEpoch/the fetching flags, so it
  // lives entirely outside the feed-window machinery.
  //
  // How much/how far to warm is decided by planPrefetch (ui/src/lib/prefetchPolicy.js)
  // — the SAME pure policy the benchmark scores and the settings panel tunes — so
  // there are no magic numbers here; the live `prefetchConfig` (a preset or the
  // user's Custom knobs) drives it.
  let lastScrollTop = 0;
  let lastScrollTs = 0;
  const warmedThumbs = new Set(); // ids already warmed (browser cache holds the bytes)
  const warmImages = new Map(); // id -> Image, held only until it loads then dropped

  /** Fire `new Image()` warms for the ahead-window tiles. `scrollTop` is
   *  grid-local (matches boxes.y), so aheadRange lines up with the layout.
   *  `belowRunwayPx`/`runwayPx` let the policy yield to an imminent loadMore. */
  function warmAhead(
    direction,
    velocity,
    scrollTop,
    viewportHeight,
    belowRunwayPx,
    runwayPx
  ) {
    const plan = planPrefetch(
      {
        velocity,
        direction,
        jumpPinned: jumpRevealPending || expandPin,
        fetchingFeed: fetchingAfter || fetchingBefore,
        belowRunwayPx,
        runwayPx,
        inFlight: warmImages.size,
      },
      prefetchConfig
    );
    if (plan.maxRequests <= 0) return;
    const { start, end } = aheadRange(boxes, {
      scrollTop,
      viewportHeight,
      aheadPx: plan.aheadPx,
      direction,
    });
    let fired = 0;
    for (let i = start; i <= end && fired < plan.maxRequests; i++) {
      const entry = displayEntries[i];
      if (!entry || entry.kind === "placeholder") continue;
      const photo = resolvePhoto(entry);
      if (!photo || photo.kind === "video") continue; // an Image() can't preload a video
      const id = photo.id;
      if (warmedThumbs.has(id)) continue;
      const status = thumbStatus.get(id);
      if (status === "ok" || status === "pending") continue; // already loaded / in flight
      warmedThumbs.add(id);
      const img = new Image();
      img.onload = img.onerror = () => warmImages.delete(id);
      // Same size bucket + v=mtimeMs the grid will request, so the URL matches
      // byte-for-byte and the real tile load is a cache hit.
      img.src = thumbUrl(photo.id, thumbSize, photo.mtimeMs);
      warmImages.set(id, img);
      fired++;
    }
  }

  function updateVisibleRange({ capture = false } = {}) {
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
    // Retain the previous window when a fling overshoots past the loaded content
    // into the bottom reserve (visibleRange goes empty). Without this the whole
    // grid tears down to `selected` alone — the "refreshes the whole page and I
    // lose context" flash (measured live: 180 mounted tiles → 1). See
    // windowing.retainWindow.
    const win = retainWindow(
      range,
      { start: renderStart, end: renderEnd },
      { entryCount: displayEntries.length }
    );
    renderStart = win.start;
    renderEnd = win.end;

    // How far can the user still scroll before hitting blank space? Prefetch has
    // to fire while that runway is longer than a fetch takes to fly, or they
    // outrun the loader — the reported "the album loading is slower than I can
    // scroll". FETCH_THRESHOLD alone can't express this: 20 display entries is a
    // few hundred pixels of burst stacks and several screens of small thumbs, and
    // the user scrolls in pixels. Keep it as a floor (it guarantees a trigger at
    // the very end of the array) and add the real one. Computed BEFORE the
    // capture block so warmAhead can yield to an imminent loadMore.
    const { above, below } = runwayPx(boxes, {
      scrollTop: -rect.top,
      viewportHeight: mainColumnEl.clientHeight,
    });
    const runway = Math.max(MIN_RUNWAY_PX, mainColumnEl.clientHeight * 2);

    // Capture the eye-point anchor (top-most visible tile) ONLY on a genuine
    // scroll/resize. Never on the boxes-recompute path (the $effect.pre below),
    // which would capture the POST-reflow position and cancel out the anchor
    // effect's correction. See layoutAnchor + the anchor $effect.
    if (capture) {
      const scrollTopLocal = -rect.top;
      const ai = topAnchorIndex(boxes, { scrollTop: scrollTopLocal });
      layoutAnchor = ai === -1 ? null : { domId: boxes[ai].id, y: boxes[ai].y };

      // Scroll velocity + direction → predictive prefetch. Warm the tiles the
      // user is scrolling toward, scaled to how fast they're going.
      const now = performance.now();
      const dt = now - lastScrollTs;
      if (lastScrollTs > 0 && dt > 0) {
        const dy = scrollTopLocal - lastScrollTop;
        const direction = dy > 0 ? "down" : dy < 0 ? "up" : null;
        if (direction) {
          warmAhead(
            direction,
            Math.abs(dy) / dt,
            scrollTopLocal,
            mainColumnEl.clientHeight,
            below,
            runway
          );
        }
      }
      lastScrollTop = scrollTopLocal;
      lastScrollTs = now;
    }

    if (
      renderEnd >= displayEntries.length - FETCH_THRESHOLD ||
      below < runway
    ) {
      // Adaptive page size (the "reach the end" fix): fetch enough items to
      // refill ~2× the runway in PIXELS, from the loaded layout's own density.
      // At small thumbs that's many hundreds; at large thumbs it stays near
      // PAGE_SIZE. See windowing.pageForRunway + prefetchPolicy.bench.test.js.
      const afterSize = adaptivePageSize
        ? pageForRunway(boxes, {
            runwayPx: runway * 2,
            min: PAGE_SIZE,
            max: PAGE_SIZE_MAX,
          })
        : PAGE_SIZE;
      loadMore("after", afterSize);
    }
    if (
      (renderStart <= FETCH_THRESHOLD || above < runway) &&
      !jumpRevealPending &&
      !expandPin
    ) {
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
      // Scroll/resize path: capture the eye-point anchor (the boxes-recompute
      // path calls updateVisibleRange() with capture off — see layoutAnchor).
      updateVisibleRange({ capture: true });
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
    // Cmd/Ctrl+A adds the current group to the selection; pressed again (once
    // the group is already all in) it asks before taking everything the filters
    // show. Cmd/Ctrl+Shift+A is the mirror image, removing instead of adding.
    // Handled before the blanket meta/ctrl bail below, but only when focus isn't
    // in a text field — there, Cmd/Ctrl+A must still select the field's text.
    if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) await bulkDeselect();
      else await bulkSelect();
      return;
    }
    if (e.metaKey || e.ctrlKey) return; // browser shortcuts

    // The shortcuts-help overlay owns the keyboard while open: '?' toggles
    // it closed, everything else is swallowed so keys don't act on the grid
    // behind it. Escape is NOT handled here — the overlay's Modal (native
    // <dialog>) owns Escape via its `cancel` event and dispatches `close`,
    // which sets shortcutsHelpOpen=false above. Handling Escape in both
    // places would double-toggle.
    if (shortcutsHelpOpen) {
      if (e.key === "?") {
        e.preventDefault();
        shortcutsHelpOpen = false;
      }
      return;
    }
    // Same contract for the settings panel: ',' toggles it closed, everything
    // else is swallowed (its inputs handle their own keys; Modal owns Escape).
    if (settingsOpen) {
      if (e.key === "," && !isTypingTarget(e.target)) {
        e.preventDefault();
        settingsOpen = false;
      }
      return;
    }
    // The user is driving now — cancel any pending post-jump pin (a jump
    // re-arms it at the end of jumpGroupBoundary, after this returns) and any
    // post-expand header pin (issue #74).
    jumpRevealPending = false;
    expandPin = null;

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
    if (isTypingTarget(e.target)) return;

    // '/' jumps to the search box — the convention everywhere from Gmail to
    // GitHub, and this is a keyboard-first app: a search you have to reach for
    // with the mouse is a search you don't use mid-cull. (The guard above means
    // this never fires while you're already typing somewhere.)
    if (e.key === "/") {
      const box = document.querySelector(".search-input");
      if (box) {
        e.preventDefault();
        box.focus();
        box.select?.();
        return;
      }
    }

    // '?' opens the keyboard-shortcuts overlay (before the empty-library
    // guard, so it works even with nothing scanned yet).
    if (e.key === "?") {
      e.preventDefault();
      shortcutsHelpOpen = true;
      return;
    }

    // ',' opens the scrolling / prefetch settings (also before the empty-library
    // guard). The convention for "preferences" everywhere from browsers to editors.
    if (e.key === ",") {
      e.preventDefault();
      settingsOpen = true;
      return;
    }

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

    // Loupe-only view toggles: I = details panel, F = filmstrip. Guarded on
    // loupeOpen so they never clash with grid usage; localStorage persists via
    // the reactive setters above.
    if (loupeOpen && (key === "i" || key === "f")) {
      e.preventDefault();
      if (key === "i") showLoupeDetails = !showLoupeDetails;
      else showLoupeFilmstrip = !showLoupeFilmstrip;
      return;
    }

    // Star rating: 1-5 set stars, 0 clears. Works in both grid and loupe.
    if (/^[0-5]$/.test(key)) {
      e.preventDefault();
      rate(selected, Number(key));
      // Auto-advance, but never onto a placeholder (see nextSelectable).
      if (loupeOpen) {
        const t = nextSelectable(displayEntries, selected + 1, 1);
        if (t !== null) focusEntry(t);
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

    // Manual stacks (issue #24): 'G' groups the current selection into one stack
    // (when it's a valid ≥2 single-group selection); 'Shift+G' dissolves bursts.
    // With a selection, it breaks apart every stacked photo in it (surgical —
    // loose photos are left alone so they can still auto-burst later); with no
    // selection it falls back to dissolving the whole stack at the cursor.
    // Enablement/logic live in the stack modules.
    if (key.toLowerCase() === "g") {
      e.preventDefault();
      if (e.shiftKey) {
        const selectedMembers = selectedStackedMemberIds(selectedIds, stacks);
        if (selectedMembers.length) {
          onDissolveStack(selectedMembers);
        } else {
          const memberIds = targetStackMemberIds(
            displayEntries[selected],
            stacks
          );
          if (memberIds) onDissolveStack(memberIds);
        }
      } else if (canCreateManualStack(items, selectedIds, groupBy)) {
        onCreateStack([...selectedIds]);
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
        if (t !== null) focusEntry(t);
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
          focusEntry(t);
        }
      } else if (key === "ArrowLeft" || key === "ArrowUp") {
        e.preventDefault();
        const t = nextSelectable(displayEntries, selected - 1, -1);
        if (t !== null) {
          if (e.shiftKey) selectRange(selected, t);
          focusEntry(t);
        }
      }
      return;
    }

    // Escape in the grid: dismiss whichever selection question is up (it must be
    // as easy to back out of as it was to raise), else collapse an expanded stack
    // if the selection is currently inside one.
    if (key === "Escape") {
      if (pendingBulk || pendingGroupSelect) {
        e.preventDefault();
        pendingBulk = null;
        pendingGroupSelect = null;
        return;
      }
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
    focusEntry(next);
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
  async function jumpGroupBoundary(direction, fromId = undefined) {
    if (jumpingGroup) return;
    // `fromId` lets a group label's own ‹/› buttons jump relative to THAT group
    // (anchored on its edge photo) instead of wherever the keyboard focus is.
    const focusId = fromId ?? safeFocusId(selected);
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
    let targetId = boundary.id;
    if (targetId == null) {
      // No further group in this direction. Rather than doing nothing (which
      // reads as "the shortcut is broken"), land on the far edge of the group
      // we're already in: Alt+Right → its LAST photo, Alt+Left → its FIRST.
      // Derive that group from the ANCHOR (focusId), not from `selected` — a
      // label-button jump anchors on a group that may not hold the focus.
      const anchorIdx = resolvedPhotos.findIndex((p) => p?.id === focusId);
      const path = deriveCurrentPath(
        anchorIdx >= 0 ? anchorIdx : selected,
        displayEntries,
        groupBy
      );
      if (!path || !path.length) return;
      let ids;
      try {
        ids = await fetchPhotoIds(
          filterIsActive(displayFilter) ? displayFilter : null,
          path,
          sort,
          direction === "next" ? "last" : "first"
        );
      } catch (err) {
        error = err.message;
        return;
      }
      const edgeId = ids[0];
      // Already sitting on that edge → genuinely nothing to do.
      if (edgeId == null || edgeId === focusId) return;
      targetId = edgeId;
    }
    await withFeedTransaction(async (epoch) => {
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
    });
  }
</script>

<!-- Last-resort UI surface. An uncaught render error or a rejected promise used
     to reach only the console, leaving the user staring at a blank/half-drawn
     feed with no idea what happened (e.g. the collapsed-nested-group crash in
     formatGroupValue). Never fail silently: put it on screen, say what to do. -->
<svelte:window
  onkeydown={onKeydown}
  onresize={scheduleVisibleRangeUpdate}
  onerror={(e) => reportUncaught("display", e.error ?? e.message)}
  onunhandledrejection={(e) => reportUncaught("background", e.reason)}
/>

<UpdateBanner />

<ServerBanner />

<div class="app">
  <Toolbar
    appVersion={APP_VERSION}
    {scanning}
    {hasNativePicker}
    {alreadyIndexed}
    {subdirs}
    {subdirsLoading}
    {subdirsError}
    {subdirSelection}
    bind:addFolderOpen
    bind:dir
    bind:recursiveScan
    bind:focusAfterAdd
    bind:subdirsOpen
    {filter}
    {filterMode}
    {groupBy}
    bind:sidebarMode
    {cyclingAll}
    {globalViewMode}
    bind:albumMode
    {detectingAlbums}
    bind:zoom
    zoomMax={ZOOM_LEVELS.length - 1}
    bind:burstEnabled
    bind:burstGapMs
    {sort}
    onchoosefolder={chooseFolder}
    onsubmit={submitAddFolder}
    onmanagelibrary={() => {
      manageLibraryOpen = true;
      refreshPendingMeta(); // the count moves as you browse — never show a stale one
    }}
    onreviewmissing={() => {
      missingReviewOpen = true;
      missingNotice = ""; // the nudge did its job; clear it once the pane is open
      refreshMissingCount();
    }}
    {missingCount}
    onloadsubdirs={loadSubdirs}
    ontoggledir={(payload) =>
      (subdirSelection = toggleSubdir(subdirSelection, payload.path, subdirs))}
    onselectalldirs={() => (subdirSelection = selectAll(subdirs))}
    onselectnodirs={() => (subdirSelection = selectNone())}
    onfiltermodechange={onFilterModeChange}
    onfilterchange={onFilterChange}
    ongroupbychange={onGroupByChange}
    oncycleall={cycleAllGroups}
    onrevealcurrent={revealCurrentLocation}
    ondetectalbums={detectAlbums}
    onsortchange={onSortChange}
    onhelp={() => (shortcutsHelpOpen = true)}
    onsettings={() => (settingsOpen = true)}
  >
    {#snippet timeline()}
      {#if timeMin != null && timeMax != null && timeMax > timeMin}
        <div
          class="time-filter"
          title="Filter by capture time — drag the handles"
        >
          <TimelineFilter
            min={timeMin}
            max={timeMax}
            times={timeTimes}
            sampled={timeSampled}
            total={timeTotal}
            viewTime={viewMarkerTime}
            focusTime={focusMarkerTime}
            value={[filter.dateFrom ?? null, filter.dateTo ?? null]}
            onrange={(range) =>
              onFilterChange({
                ...filter,
                dateFrom: range[0],
                dateTo: range[1],
              })}
          />
        </div>
      {/if}
    {/snippet}

    {#snippet manageLibrary()}
      {#if manageLibraryOpen}
        <ManageLibrary
          {library}
          {pendingMeta}
          {sweeping}
          onclose={() => (manageLibraryOpen = false)}
          onsweep={sweepMetadata}
          onfolderRemoved={onFolderRemoved}
          onlibraryReset={onLibraryReset}
        />
      {/if}
    {/snippet}
  </Toolbar>

  {#if missingReviewOpen}
    <MissingReview
      onclose={() => (missingReviewOpen = false)}
      onchanged={onMissingChanged}
    />
  {/if}

  <div class="app-body">
    <!-- Resizable sidebar pane: owns the width (persisted) for BOTH sidebar
         modes, so the tree/fisheye components just fill it. -->
    <div class="sidebar-pane" style="width:{sidebarWidth}px">
      {#if sidebarMode === "tree"}
        <TreeSidebar
          bind:this={treeSidebarRef}
          {groupBy}
          {collapsedPaths}
          snapshotKeys={snapshotGroupKeys}
          {sort}
          filter={displayFilter}
          refreshToken={libraryVersion}
          {tokenStats}
          focusKey={focusHereKey}
          viewKey={viewHereKeyDistinct}
          ontoggle={(d) => onGroupToggle(d.path, d.event, d.paths)}
          onjump={(p) => jumpToPath(p)}
          oncontextmenu={(d) => openTreeMenu(d)}
        />
      {:else}
        <FisheyeSidebar
          {groupBy}
          {currentPath}
          {sort}
          filter={displayFilter}
          refreshToken={libraryVersion}
          onjump={(p) => jumpToPath(p)}
        />
      {/if}
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="sidebar-resizer"
      class:dragging={resizingSidebar}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar (double-click to reset)"
      tabindex="0"
      title="Drag to resize the sidebar (double-click to reset)"
      onpointerdown={startSidebarResize}
      ondblclick={() => (sidebarWidth = DEFAULT_SIDEBAR_WIDTH)}
      onkeydown={onSidebarResizeKey}
    ></div>
    <div
      class="main-column"
      bind:this={mainColumnEl}
      onscroll={scheduleVisibleRangeUpdate}
      onwheel={() => ((jumpRevealPending = false), (expandPin = null))}
      style="--reveal-margin:{revealMargin}px"
    >
      {#if albumMode}
        <AlbumsView
          photos={albumPhotos}
          truncated={albumTruncated}
          limit={albumLimit}
          defaultDest={currentFolder || ""}
          {currentFolderName}
          {hasNativePicker}
          prefs={albumPrefs}
          autoOpenSetup={albumAutoOpenSetup}
          onrelimit={(v) => onAlbumRelimit(v)}
          onclose={() => (albumMode = false)}
          onopenphoto={(d) => openPhotoById(d.id)}
          onprefschange={(p) => (albumPrefs = saveAlbumPrefs(p))}
          onmaterialized={(d) => onAlbumsMaterialized(d)}
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
                class:nested={header.depth > 0}
                data-group-key={header.path ? pathKey(header.path) : undefined}
                style="--depth:{header.depth}; --ind:{GROUP_INDENT}px; top:{header.y}px; height:{header.endY -
                  header.y}px;"
              >
                <!-- Right-click opens the group menu; the header's own buttons
                     already carry every action for keyboard/pointer, so this is a
                     supplementary affordance (same as the tree row). -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  class="section-header"
                  style="top:{header.depth *
                    HEADER_HEIGHT}px; z-index:{Z_HEADER_BASE - header.depth};"
                  oncontextmenu={(e) => openHeaderMenu(e, header)}
                >
                  <button
                    class="section-toggle-icon"
                    class:not-grid={rendererIdFor(
                      header.path,
                      collapsedKeys,
                      snapshotGroupKeys
                    ) !== DEFAULT_RENDERER_ID}
                    title={groupToggleTitle(
                      rendererIdFor(
                        header.path,
                        collapsedKeys,
                        snapshotGroupKeys
                      )
                    )}
                    aria-label="Cycle this group: full grid → snapshot strip → collapsed"
                    onclick={(e) =>
                      onGroupToggle(
                        header.path,
                        e,
                        header.isVirtual ? header.groupPaths : undefined
                      )}
                  >
                    <GroupStateIcon
                      state={getRenderer(
                        rendererIdFor(
                          header.path,
                          collapsedKeys,
                          snapshotGroupKeys
                        )
                      ).icon}
                    />
                  </button>
                  <!-- OUTSIDE .section-label, which is `direction: rtl` so it can
                       clip the HEAD of a long path — that flips the visual order
                       of its inline children, and an icon placed inside it lands
                       to the RIGHT of the name. Says "this group is a real folder"
                       (so reveal / rescan / rename / remove all apply); hollow
                       means a virtual ancestor, which has no row in the index and
                       therefore cannot be renamed or removed. -->
                  {#if isFolderDim(header)}
                    <FolderIcon virtual={header.isVirtual} />
                  {/if}
                  {#if header.path && renamingKey === pathKey(header.path)}
                    <!-- svelte-ignore a11y_autofocus -->
                    <input
                      class="section-rename"
                      bind:value={renameDraft}
                      onclick={(e) => e.stopPropagation()}
                      onkeydown={(e) => {
                        if (e.key === "Enter") commitRename(header.path);
                        else if (e.key === "Escape") cancelRename();
                      }}
                      onblur={() => commitRename(header.path)}
                      autofocus
                    />
                  {:else}
                    <button
                      class="section-label"
                      title={`${header.value ?? header.label}${
                        header.path?.at(-1)?.dimension === "folder" &&
                        !header.isVirtual
                          ? " — double-click to rename this folder on disk"
                          : ""
                      }`}
                      ondblclick={() =>
                        !header.isVirtual && startRename(header.path)}
                    >
                      <span
                        class="section-label-text"
                        use:tailClip={headerParts(
                          header,
                          tokenStats,
                          libraryRoots
                        )}
                        >{#each headerParts(header, tokenStats, libraryRoots) as part}<span
                            class="part-{part.kind}">{part.text}</span
                          >{/each}</span
                      >
                    </button>
                  {/if}
                  <!-- A virtual ancestor has no `folders` row, so no query can
                       count it — its number comes from the trie's roll-up, the
                       same one the sidebar shows. -->
                  {#if header.count ?? headerCounts[pathKey(header.path)]}
                    <span class="section-count">
                      {(
                        header.count ?? headerCounts[pathKey(header.path)]
                      ).toLocaleString()} items
                    </span>
                  {/if}
                  {#if header.path}
                    <GroupLabelActions
                      selectState={groupSelectState(
                        header.path,
                        header.groupPaths,
                        selectedIds,
                        groupIdCacheVersion,
                        groupSelSig
                      )}
                      isFolder={!header.isVirtual &&
                        isRemovableFolder(header.path)}
                      removeArmed={removeArmedKey === pathKey(header.path)}
                      ontoggleselect={(e) =>
                        toggleGroupSelectAll(header.path, header.groupPaths, e)}
                      onkeeponly={() =>
                        keepOnlyGroup(header.path, header.groupPaths)}
                      onjumpprev={() => jumpFromGroup(header.path, "prev")}
                      onjumpnext={() => jumpFromGroup(header.path, "next")}
                      onremove={() => removeAlbum(header.path)}
                    />
                  {/if}
                </div>
              </div>
            {/each}
            {#each visibleItems as { i, entry } (entryDomId(entry))}
              {#if entry.kind === "placeholder"}
                <!-- The group's own section header (above) owns the label, icon,
                     count and actions. This band is ONLY the renderer's photo
                     widget, drawn inside the layout's content rect — which is why
                     it inherits the group's nesting indent. A renderer with no
                     component (e.g. "collapsed") reserves no band at all: the
                     header alone represents the group. See
                     docs/superpowers/specs/2026-07-12-group-photo-renderers.md -->
                {@const renderer = getRenderer(
                  rendererIdFor(
                    entry.item.path,
                    collapsedKeys,
                    snapshotGroupKeys
                  )
                )}
                {#if renderer.component && boxes[i].height > 0}
                  {@const Renderer = renderer.component}
                  <!-- + PAD on BOTH axes, exactly as Thumb does (`box.x + pad`).
                       Absolutely-positioned children ignore the grid's CSS
                       padding, so every box has to add the frame inset itself —
                       and the band wasn't. That put every snapshot strip 12px
                       left of, and 12px above, where the same group's photos sit
                       in full view, so a group visibly JUMPED as you toggled it. -->
                  <!-- The strip UNFURLS in place: it opens from the exact spot,
                       and at the exact photo size, that the group's first row of
                       photos occupied, while the photos below it glide up. `foldMs`
                       is 0 unless a fold is actually landing — the feed is
                       virtualized, so without that guard every scroll past a
                       snapshot group would re-mount the band and replay the
                       animation (and prefers-reduced-motion zeroes it too).

                       |global is load-bearing: a bare `in:` is LOCAL, and a local
                       transition is suppressed when an ancestor block is created in
                       the same update — which is exactly what a feed refresh does,
                       so the animation silently never ran at all. -->
                  <div
                    class="group-band"
                    data-group-key={pathKey(entry.item.path)}
                    in:scale|global={{
                      duration: foldMs,
                      start: 0.92,
                      opacity: 0,
                    }}
                    style="top:{boxes[i].y + PAD}px; left:{boxes[i].x +
                      PAD}px; width:{boxes[i].width}px; height:{boxes[i]
                      .height}px;"
                  >
                    <Renderer
                      groupPath={entry.item.path}
                      count={entry.item.count}
                      filter={displayFilter}
                      {sort}
                      {groupBy}
                      thumbPx={boxes[i].height}
                      gapPx={gridGap}
                      size={snapshotThumbSize}
                      onselect={(d) => openPhotoById(d.id, entry.item.path)}
                    />
                  </div>
                {/if}
              {:else}
                <Thumb
                  item={resolvePhoto(entry)}
                  box={boxes[i]}
                  pad={PAD}
                  size={thumbSize}
                  warm={thumbStatus.get(resolvePhoto(entry).id) === "ok"}
                  selected={i === selected}
                  inSelection={selectedIds.has(resolvePhoto(entry).id)}
                  showSize={sort.by === "size"}
                  stackCount={entry.kind === "stack"
                    ? entry.stack.count
                    : undefined}
                  stackPeekItems={entry.kind === "stack" ? entry.peekItems : []}
                  stackMarginPx={stackMarginPx(entry)}
                  inExpandedStack={entry.kind === "photo" &&
                    entry.stackId !== null}
                  isCurrentCover={entry.kind === "photo" &&
                    entry.stackId !== null &&
                    stacks.find((s) => s.id === entry.stackId)?.coverId ===
                      entry.item.id}
                  onclick={(e) => onTileClick(e, entry, i)}
                  ontoggleselect={() => toggleSelect(resolvePhoto(entry)?.id)}
                  oncontextmenu={(e) => onTileContextMenu(e, entry, i)}
                  onattempt={handleThumbAttempt}
                  onsettled={handleThumbSettled}
                />
              {/if}
            {/each}
          {/if}
        </div>
      {:else if !scanning && status !== "loading…"}
        {#if libraryTotal === 0}
          <div class="empty">
            <p class="empty-title">Nothing indexed yet</p>
            <p class="empty-hint">
              Add a folder of photos or videos to get started.
            </p>
            <button
              class="empty-action"
              onclick={() =>
                hasNativePicker ? chooseFolder() : (addFolderOpen = true)}
            >
              Add folder…
            </button>
          </div>
        {:else if filterIsActive(filter) || keepIds}
          <div class="empty">
            <p class="empty-title">No photos match your current filters.</p>
            <p class="empty-hint">
              {libraryTotal.toLocaleString()} photos are indexed — none match the
              active
              {activeFacetLabels.length
                ? activeFacetLabels.join(" + ") + " filter"
                : "filters"}{activeFacetLabels.length > 1 ? "s" : ""}. Widen or
              clear them to see photos again.
            </p>
            <button class="empty-action" onclick={clearAllFilters}
              >Clear filters</button
            >
          </div>
        {:else}
          <div class="empty">
            <p class="empty-title">No photos to show here.</p>
            <p class="empty-hint">
              {libraryTotal.toLocaleString()} photos are indexed. Try a different
              grouping or sort.
            </p>
          </div>
        {/if}
      {/if}
    </div>
    {#if scrubberManifest && items.length}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="scrubber-resizer"
        class:dragging={resizingScrubber}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize scrubber (double-click to reset)"
        tabindex="0"
        title="Drag to resize the scrubber (double-click to reset)"
        onpointerdown={startScrubberResize}
        ondblclick={() => (scrubberWidth = DEFAULT_SCRUBBER_WIDTH)}
        onkeydown={onScrubberResizeKey}
      ></div>
      <div class="scrubber-rail" style="flex-basis:{scrubberWidth}px">
        <Scrubber
          manifest={scrubberManifest}
          axis={scrubberAxis}
          {groupBy}
          {sort}
          topCount={scrubberTopCount}
          viewportCount={scrubberViewportCount}
          times={DATE_SORT_ATTRS.includes(sort.by) ? timeTimes : null}
          {timeMin}
          {timeMax}
          onjump={(path) => jumpToPath(path)}
        />
      </div>
    {/if}
  </div>

  <StatusBar
    {libraryTotal}
    {showingCount}
    {selectedCount}
    {status}
    {error}
    notice={missingNotice}
    {thumbProgress}
    {thumbCounts}
  >
    <!-- The scope chip explains the "showing" count it sits next to. -->
    {#snippet scope()}
      {#if chip}
        <button class="scope-chip" onclick={exitScope} title={chip.title}>
          {chip.icon}
          {chip.text} ✕
        </button>
      {/if}
    {/snippet}

    <!-- Background jobs: a pill in the corner that opens a scrollable list, not
         a strip that takes height from the grid for every video you play. -->
    {#snippet jobs()}<JobsPanel />{/snippet}

    <!-- Clear / Keep only / Export live next to the selected count now: that is
         what makes "Clear" read as "clear the selection" rather than "clear
         something, somewhere". -->
    {#snippet selection()}
      <SelectionBar
        {selectedCount}
        {lastClearedSelection}
        {hasNativePicker}
        {exporting}
        {exportResult}
        bind:exportOpen
        bind:exportDest
        bind:exportName
        bind:exportMove
        {pendingBulk}
        pendingCount={pendingBulkCount}
        pendingGroup={pendingGroupSelect && {
          count: pendingGroupSelect.ids.length,
          label: pendingGroupSelect.label,
        }}
        onbulkconfirm={confirmPendingBulk}
        onbulkcancel={() => (pendingBulk = null)}
        ongroupconfirm={confirmPendingGroupSelect}
        ongroupcancel={() => (pendingGroupSelect = null)}
        {rereading}
        onclear={clearSelection}
        onkeeponly={keepOnlySelection}
        onreread={rereadSelection}
        onundoclear={undoClearSelection}
        onchoosedest={chooseExportDest}
        onexport={doExport}
      />
    {/snippet}
  </StatusBar>
</div>

{#if loupeOpen}
  <Loupe
    items={resolvedPhotos}
    burstInfo={loupeBurstInfo}
    ontoggleburst={(d) => loupeToggleBurst(d.stackId)}
    bind:index={selected}
    inSelection={typeof resolvedPhotos[selected]?.id === "number" &&
      selectedIds.has(resolvedPhotos[selected].id)}
    {selectedCount}
    {selectedIds}
    showDetails={showLoupeDetails}
    showFilmstrip={showLoupeFilmstrip}
    thumbSize={filmstripThumbSize}
    oncontextmenu={(d) => openContextMenu(d.x, d.y, selected)}
    onclose={closeLoupe}
    onrate={(v) => rate(selected, v)}
    ontoggleselect={() => toggleSelect(resolvedPhotos[selected]?.id)}
  />
{/if}

{#if contextMenu.open}
  <ContextMenu
    x={contextMenu.x}
    y={contextMenu.y}
    items={contextMenuItems}
    onclose={() => (contextMenu.open = false)}
  />
{/if}

{#if treeMenu.open}
  <ContextMenu
    x={treeMenu.x}
    y={treeMenu.y}
    items={treeMenu.items}
    onclose={() => (treeMenu.open = false)}
  />
{/if}

<!-- Remove is the one destructive item in the tree's menu, and ContextMenu closes
     on every action — so the group header's two-click "arm" cannot survive in
     there. The confirm lives here instead, where it outlives the menu, and says
     exactly what will and will not happen: the folder's rows and RATINGS leave
     the index; the photos on disk are not touched. -->
{#if removeFolderPending}
  <Modal
    open={true}
    title="Remove folder from library?"
    size="sm"
    onclose={() => (removeFolderPending = null)}
  >
    <p class="confirm-body">
      <strong>{removeFolderPending.folderPath}</strong>
    </p>
    <p class="confirm-note">
      This drops this folder — and any sub-folders inside it — with their photos
      and ratings, from the index. The files on disk are not touched, and a
      rescan brings the photos back (unrated).
    </p>
    <div class="confirm-actions">
      <button
        class="confirm-cancel"
        onclick={() => (removeFolderPending = null)}
      >
        Cancel
      </button>
      <button class="confirm-remove" onclick={confirmRemoveFolder}>
        Remove from library
      </button>
    </div>
  </Modal>
{/if}

{#if shortcutsHelpOpen}
  <ShortcutsOverlay onclose={() => (shortcutsHelpOpen = false)} />
{/if}

{#if settingsOpen}
  <SettingsPanel
    onclose={() => (settingsOpen = false)}
    bind:preset={prefetchPreset}
    bind:custom={prefetchCustom}
    bind:adaptivePageSize
    bind:scrubberAxis
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
  /* The sidebar pane owns the (persisted, draggable) width; the tree/fisheye
     components inside just fill it. flex-shrink:0 so the grid can't squeeze it. */
  .sidebar-pane {
    flex: 0 0 auto;
    min-height: 0;
    display: flex;
    overflow: hidden;
  }
  /* A slim grab strip between the sidebar and the grid. Widened hit area via
     padding-box trickery isn't needed — 6px + a hover tint reads fine. */
  .sidebar-resizer {
    flex: 0 0 6px;
    cursor: col-resize;
    background: #2a2a2a;
    border: none;
    padding: 0;
    transition: background 0.12s;
  }
  .sidebar-resizer:hover,
  .sidebar-resizer:focus-visible,
  .sidebar-resizer.dragging {
    background: #4c9aff;
    outline: none;
  }
  .main-column {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
  }
  /* Fixed-width right-edge column for the scrubber. As a flex sibling of
     .main-column (flex:1), it reserves its width cleanly — the grid reflows to
     fit — and never scrolls with the feed. */
  .scrubber-rail {
    /* width comes from the inline flex-basis (resizable, persisted) */
    flex: 0 0 auto;
    min-width: 0;
    padding: 6px 4px 6px 0;
    /* visible + a stacking context above the grid so a hovered/dragged label can
       expand LEFT over the feed and be fully readable */
    overflow: visible;
    position: relative;
    z-index: 6;
  }
  /* Drag handle on the rail's LEFT edge (mirrors .sidebar-resizer). */
  .scrubber-resizer {
    flex: 0 0 6px;
    cursor: col-resize;
    background: #2a2a2a;
    border: none;
    padding: 0;
    z-index: 6;
    transition: background 0.12s;
  }
  .scrubber-resizer:hover,
  .scrubber-resizer:focus-visible,
  .scrubber-resizer.dragging {
    background: #4c9aff;
    outline: none;
  }
  /* The timeline, slotted into the toolbar's Filter group. It lives here because
     App renders it (a dozen props of App's own state), so it is in App's style
     scope — but the flex sizing that lets it take the row's slack lives in
     ToolGroup, next to the rest of the toolbar's shrink order.

     The side padding is not cosmetic: the widget centres a date badge on each
     handle, and the handles sit at the very ends of the axis, so both badges
     overhang by ~12px. Without room for them, `overflow: hidden` ate the "J" of
     "Jan 1, 1980" at one end and the year at the other. */
  .time-filter {
    padding: 0 16px;
    /* NOT `overflow: hidden`. That was here to stop the axis spilling out of the
       row, but it also clipped the widget's own settings popover — the gear
       opened into nothing. The padding is what the end-date badges need (they are
       centred on the handles and overhang each end); the clipping was never the
       thing keeping the row tidy, the flex shrink order is. */
    overflow: visible;
  }

  /* The one scope chip. Both kinds of scope (a folder, a hand-picked id set)
     are the same idea to the user — "you're seeing a subset" — so they share a
     chip and an exit; the leading icon (▣ / ●) says which kind it is. */
  /* The tree menu's Remove confirmation. */
  .confirm-body {
    margin: 0 0 6px;
    word-break: break-all;
    color: #e8e8e8;
  }
  .confirm-note {
    margin: 0 0 14px;
    color: #9a9a9a;
    font-size: 0.85rem;
    line-height: 1.45;
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .confirm-cancel,
  .confirm-remove {
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
  }
  .confirm-cancel {
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    color: #e8e8e8;
  }
  .confirm-remove {
    background: #5a1a1a;
    border: 1px solid #a33;
    color: #ffd7d7;
  }
  .confirm-remove:hover {
    background: #7a2020;
    color: #fff;
  }
  .scope-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: #1e2a4a;
    border: 1px solid #4c6fcf;
    color: #9db8ff;
    border-radius: 12px;
    padding: 3px 10px;
    font-size: 0.78rem;
    cursor: pointer;
    white-space: nowrap;
    max-width: 20rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .scope-chip:hover {
    background: #263562;
  }
  .grid {
    /* Justified layout: children are absolutely positioned by computed boxes;
       height is set inline from the layout result. */
    position: relative;
    width: 100%;
    /* Its own stacking context. Without this the grid is `position:relative;
       z-index:auto`, which is NOT one — so the headers (z 15), the dendrogram
       trunk (16) and the thumbnails (10) all resolved against .topbar's z 20 in
       the shared root context. That capped the header scale at 20 (folder
       nesting can go deeper than that) and, separately, meant a thumbnail was
       only ever one z-index bump away from painting over the toolbar. Isolating
       frees the internal scale and closes that hazard; the topbar and the loupe
       both live OUTSIDE .grid, so nothing that must sit above it is affected. */
    isolation: isolate;
  }
  .grid:focus {
    outline: none;
  }
  /* Nesting is drawn as a dendrogram: each level is indented, a dotted trunk runs
     down the sub-group's spine, and a dotted elbow joins each child header to it
     — so a sub-group visibly belongs to the group above instead of floating as
     just another header. `--depth` is set on the wrapper; custom properties
     inherit, so the header reads it from there. */
  /* The renderer's band: just a positioned rect. The group's label/icon/actions
     live in its section header above — a renderer never draws chrome. */
  .group-band {
    position: absolute;
    box-sizing: border-box;
    overflow: hidden;
    /* The strip unrolls from its left edge — which, since the band now starts at
       exactly the same x as the group's first photo in full view, means it appears
       to grow out of that photo rather than swelling out of thin air. */
    transform-origin: 0 50%;
  }

  /* NOTE the transition that ISN'T here: `.thumb-wrap` already carries a
     permanent top/left/width/height transition of its own (Thumb.svelte), so the
     photos below a folding group have always glided to their new places. The
     piece that was missing is the strip itself — see the `in:scale` on the band,
     and `folding` in the script, which is what keeps a virtualized re-mount from
     replaying that unfurl every time you scroll past. */

  .section-wrapper {
    /* --ind is set inline from GROUP_INDENT (the same constant the LAYOUT uses to
       inset a nested group's photos) so the dendrogram and the photos can never
       drift apart. The fallback only matters if the attr is ever dropped. */
    --ind: 18px;
    --trunk: calc(15px + (var(--depth, 0) - 1) * var(--ind));
    position: absolute;
    left: 0;
    width: 100%;
    pointer-events: none;
  }
  /* Vertical trunk spanning this sub-group's whole extent — consecutive siblings
     stack their segments into one continuous line. */
  .section-wrapper.nested::before {
    content: "";
    position: absolute;
    left: var(--trunk);
    top: 0;
    bottom: 0;
    /* Must beat EVERY section header: they are sticky with an OPAQUE background,
       so at 'auto' the trunk was painted over wherever a header sat and the
       elbows looked like floating stubs. Headers run Z_HEADER_BASE - depth, so
       one above the base clears all of them at any nesting depth. It runs up the
       header's left padding gutter, which the per-depth padding reserves. */
    z-index: 1001;
    border-left: 1px dotted #6a6a6a;
    pointer-events: none;
  }
  .section-header {
    position: sticky;
    z-index: 15;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px calc(8px + var(--depth, 0) * var(--ind));
    background: #141414;
    pointer-events: auto;
  }
  /* The elbow from the trunk into this header. */
  .section-wrapper.nested > .section-header::before {
    content: "";
    position: absolute;
    left: var(--trunk);
    width: calc(var(--ind) - 4px);
    top: 50%;
    z-index: 1001;
    border-top: 1px dotted #6a6a6a;
    pointer-events: none;
  }
  /* Same tri-state icon (and same colour language) as the tree sidebar's
     feed-visibility control, so one group state always reads the same way:
     grid = full, strip = snapshot, bar = collapsed (amber once it's not full). */
  .section-toggle-icon {
    background: none;
    border: none;
    color: #8a8a8a;
    font: inherit;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
  }
  .section-toggle-icon:hover {
    color: #e8e8e8;
  }
  /* Amber whenever the group isn't showing its photos in full. One modifier —
     NEVER interpolate a renderer id into the class list: "grid" collides with
     the photo-grid container's own .grid rule. */
  .section-toggle-icon.not-grid {
    color: #ffd24c;
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
    /* A long group name used to WRAP, growing the sticky header band and letting
       it cover the rows beneath it. Keep it to one line; the full value is on the
       button's title attribute (see the markup).

       Clip the HEAD, not the tail — same rule as the tree rows. A folder path
       ends with the folder's own name, so a normal ellipsis drops exactly the
       part that identifies the group: two sibling folders under one long parent
       both render as ".../2025_11Nov_08 Canon 1/2…" and become indistinguishable.
       direction:rtl on the clipper flips which end overflows; the inner span
       stays ltr, so the text itself is unchanged. */
    direction: rtl;
    white-space: nowrap;
    overflow: hidden;
    min-width: 0;
    max-width: 78ch;
  }
  /* Only fade the left edge when there IS something clipped behind it. */
  .section-label.clipped {
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 16px);
    mask-image: linear-gradient(to right, transparent 0, #000 16px);
  }
  .section-label-text {
    display: inline-block;
    direction: ltr;
    white-space: nowrap;
  }
  .section-header {
    min-width: 0;
  }
  /* Layering: the folder's own name is what identifies the section, so it gets
     the emphasis; the path above it is context and recedes. Nothing the eye needs
     is deleted — it just stops competing for attention. */
  .section-label .part-keep {
    color: inherit;
  }
  .section-label .part-dim,
  .section-label .part-ellipsis {
    color: #8a8a8a;
    font-weight: 400;
  }
  .section-label:hover {
    background: #2a2a2a;
  }
  .section-rename {
    font: inherit;
    font-weight: 600;
    color: #fff;
    background: #0d0d0d;
    border: 1px solid #4c9aff;
    border-radius: 4px;
    padding: 2px 6px;
    min-width: 12ch;
  }
  .section-rename:focus {
    outline: none;
  }
  .section-count {
    color: #888;
    font-size: 0.85em;
    font-weight: 400;
    /* Matches the collapsed-section placeholder's own count (.placeholder-count)
       so a section reads the same expanded or collapsed. */
  }
  /* The group actions (jump / Keep only / Remove) live in GroupLabelActions
     (issue #88); its select icon is always visible, but its action buttons
     (.gla-buttons) reveal only on hover of the header row. The reveal target
     crosses the component boundary, so it's a :global rule. There is now ONE
     header per group (see the group-renderers contract), so this is one rule —
     it used to be repeated for the snapshot head and the collapsed pill. */
  .section-header:hover :global(.gla-buttons),
  .section-header:focus-within :global(.gla-buttons) {
    opacity: 1;
  }
  .empty {
    padding: 4rem 1rem;
    text-align: center;
    color: #777;
  }
  .empty-title {
    margin: 0 0 0.4rem;
    font-size: 1rem;
    color: #bbb;
  }
  .empty-hint {
    margin: 0 auto 1rem;
    max-width: 32rem;
    font-size: 0.85rem;
    line-height: 1.5;
  }
  .empty-action {
    background: #4c9aff;
    color: #06121f;
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }
  .empty-action:hover {
    background: #6aabff;
  }
</style>
