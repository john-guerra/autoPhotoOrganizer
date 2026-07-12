<script>
  import { onMount, tick } from "svelte";
  import { sectionedJustifiedLayout } from "./lib/layouts/sectionedJustified.js";
  import { visibleRange } from "./lib/layouts/windowing.js";
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
    fetchTimes,
    setScope,
    removeFolderByPath,
    renameFolder,
    revealInFinder,
    revealSelection,
  } from "./lib/api.js";
  import { jobs, waitForJob, takeNewlyFinished } from "./lib/jobs.js";
  import Thumb, { PEEK_STEP_PX, MAX_PEEK_DEPTH } from "./lib/Thumb.svelte";
  import Loupe from "./lib/Loupe.svelte";
  import ContextMenu from "./lib/ContextMenu.svelte";
  import ShortcutsOverlay from "./lib/ShortcutsOverlay.svelte";
  import JobsPanel from "./lib/JobsPanel.svelte";
  import GroupStateIcon from "./lib/GroupStateIcon.svelte";
  import ServerBanner from "./lib/ServerBanner.svelte";
  import { startServerWatchdog, serverRestarted } from "./lib/serverHealth.js";
  import TreeSidebar from "./lib/TreeSidebar.svelte";
  import FisheyeSidebar from "./lib/FisheyeSidebar.svelte";
  import UpdateBanner from "./lib/UpdateBanner.svelte";
  import ManageLibrary from "./lib/ManageLibrary.svelte";
  import AlbumsView from "./lib/AlbumsView.svelte";
  import { loadAlbumPrefs, saveAlbumPrefs } from "./lib/albumPrefs.js";
  import SnapshotStrip from "./lib/SnapshotStrip.svelte";
  import SourceControls from "./lib/SourceControls.svelte";
  import OrganizeControls from "./lib/OrganizeControls.svelte";
  import ViewControls from "./lib/ViewControls.svelte";
  import SelectionBar from "./lib/SelectionBar.svelte";
  import GroupLabelActions from "./lib/GroupLabelActions.svelte";
  import { selectState, intersectionCount } from "./lib/groupSelection.js";
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
  let burstGapMs =
    Number.isFinite(storedBurstGap) && storedBurstGap >= 0
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
  // WIP (issue #90 — "collapse to snapshot → thumbs broken"). Snapshot strips
  // reuse the grid's cached thumbnails instead of a unique cold size: follow the
  // grid's current bucket, clamped to [320,640] so it never drops to the
  // always-cold 160 and never over-fetches 1024 for a ~104px slot. Both
  // endpoints are real buckets, so reuse holds at common zooms.
  $: snapshotThumbSize = Math.min(640, Math.max(320, thumbSize));

  let dir = localStorage.getItem(LS_KEY) || "";
  // Recursive "soup folder" scan: pull in every subfolder. Default on — the
  // common case is pointing at a parent of dated album folders.
  const LS_RECURSIVE = "autogallery.recursiveScan";
  let recursiveScan = localStorage.getItem(LS_RECURSIVE) !== "false";
  $: localStorage.setItem(LS_RECURSIVE, String(recursiveScan));

  // Loupe view toggles (issues #27/#28): details panel + filmstrip, default on,
  // remembered. Toggled with I / F while the loupe is open (see onKeydown).
  const LS_LOUPE_DETAILS = "autogallery.loupeDetails";
  const LS_LOUPE_FILMSTRIP = "autogallery.loupeFilmstrip";
  let showLoupeDetails = localStorage.getItem(LS_LOUPE_DETAILS) !== "false";
  let showLoupeFilmstrip = localStorage.getItem(LS_LOUPE_FILMSTRIP) !== "false";
  $: localStorage.setItem(LS_LOUPE_DETAILS, String(showLoupeDetails));
  $: localStorage.setItem(LS_LOUPE_FILMSTRIP, String(showLoupeFilmstrip));
  const LS_GROUP_BY = "autogallery.groupBy";
  let groupBy = (() => {
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
  })();
  $: localStorage.setItem(LS_GROUP_BY, JSON.stringify(groupBy));

  // Global feed sort (attribute + direction). Threaded into every feed/tree/
  // boundary call; date sorts re-derive the year/month/day grouping (server-side
  // applySortToDims), so grouping and sorting agree on one date notion.
  const LS_SORT = "autogallery.sort";
  let sort = (() => {
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
  })();
  $: localStorage.setItem(LS_SORT, JSON.stringify(sort));

  const LS_FILTER = "autogallery.filter";
  let filter = (() => {
    try {
      const stored = JSON.parse(localStorage.getItem(LS_FILTER) ?? "null");
      if (stored && typeof stored === "object")
        return { ...DEFAULT_FILTER, ...stored };
    } catch {
      /* fall through to default */
    }
    return { ...DEFAULT_FILTER };
  })();
  $: localStorage.setItem(LS_FILTER, JSON.stringify(filter));

  // The timeline reflects the feed's SORT date. A date sort becomes the
  // timeline's attribute (and is remembered); a non-date sort (rating/size/name)
  // keeps the last date attr. Seed from the persisted sort/filter so the timeline
  // matches the sort on first paint. `lastDateSort` is the remembered date attr.
  let lastDateSort = DATE_SORT_ATTRS.includes(sort.by)
    ? sort.by
    : DATE_SORT_ATTRS.includes(filter.dateAttr)
      ? filter.dateAttr
      : "date_taken";
  if (filter.dateAttr !== lastDateSort)
    filter = { ...filter, dateAttr: lastDateSort };

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

  // "Open a folder" focus: when non-null, an abs path whose subtree (the folder
  // + everything under it) the feed/tree/counts/albums scope to via the
  // folderPath filter key, while the library total keeps showing the whole
  // index. The folder is a permanent library member (it was scanned in); focus
  // is just a scoped view. Persisted so it survives a reload. null = unfocused.
  const LS_FOCUS_PATH = "autogallery.focusPath";
  let focusPath = localStorage.getItem(LS_FOCUS_PATH) || null;
  $: focusName = focusPath
    ? focusPath.split("/").filter(Boolean).pop() || focusPath
    : "";
  $: if (focusPath) localStorage.setItem(LS_FOCUS_PATH, focusPath);
  else localStorage.removeItem(LS_FOCUS_PATH);

  // Auto-albums review mode: replaces the grid with a time-gap-clustered view
  // of the working set (see AlbumsView).
  let albumMode = false;
  let albumPhotos = [];
  let albumTruncated = false;
  let detectingAlbums = false;
  // Max photos pulled into the album timeline (user-tunable; server hard-caps).
  let albumLimit =
    Number(localStorage.getItem("autogallery.albumLimit")) || 20000;
  // Global Auto-Albums prefs (template/gapMode/fixedGapMs/k/move), persisted
  // in localStorage — see albumPrefs.js. AlbumsView owns the live working
  // copy; its `prefschange` just asks us to persist + re-seed it.
  let albumPrefs = loadAlbumPrefs();
  // Open the Auto-albums setup/explainer modal automatically only the very
  // FIRST time the mode is ever entered (persisted across reloads/sessions —
  // see LS_ALBUM_SETUP_SEEN in detectAlbums); later entries go straight to the
  // review. The ⚙ Options button still opens it on demand.
  const LS_ALBUM_SETUP_SEEN = "autogallery.albumSetupSeen";
  let albumAutoOpenSetup = false;
  // Fallback folder for Auto-Albums' destination/naming default when neither
  // focusPath nor the current groupBy grouping yields a folder (e.g. grouped
  // by year/camera/kind only) — resolved once per detectAlbums() call from
  // the first album photo's own folder, since album-timeline photos
  // (albumPhotos) carry no path of their own (see fetchAlbumTimeline).
  let albumFirstPhotoFolder = null;

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
    // Folder-focus ("open a folder"): scope the whole app to the focused
    // subtree. A live WHERE over folders.abs_path — stays correct across
    // rescans, no id enumeration, persists as a single path string.
    ...(focusPath ? { folderPath: focusPath } : {}),
    // dateAttr is which date the timeline PLOTS, not a constraint — so it follows
    // the sort date in both modes (in select mode the rest resets to DEFAULT, but
    // the timeline column must still track the sort).
    dateAttr: filter.dateAttr,
  };

  // --- Timeline filter (brushable density under the toolbar) ----------------
  // The timeline's KDE is a crossfilter: it reflects the OTHER active facets
  // (rating/orientation/keep-scope) but NOT the time range itself, so brushing
  // never collapses the histogram you're brushing within. timesFilter is
  // displayFilter with the time facet stripped; timesKey is its stable
  // signature so we refetch only when the non-time facets or the library
  // change — never on a brush.
  let timeMin = null;
  let timeMax = null;
  let timeTimes = [];
  let timesEpoch = 0;
  $: timesFilter = (() => {
    const { dateFrom, dateTo, ...rest } = displayFilter;
    return rest;
  })();
  $: timesKey = JSON.stringify(timesFilter) + "|" + libraryVersion;
  let lastTimesKey = null;
  $: if (timesKey !== lastTimesKey) {
    lastTimesKey = timesKey;
    refreshTimes(timesFilter);
  }
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
    } catch (e) {
      // Non-fatal: the strip just hides (timeMin stays null); feed unaffected.
      if (epoch === timesEpoch) {
        timeMin = null;
        timeMax = null;
        timeTimes = [];
      }
    }
  }

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
  // --- Resizable sidebar (drag its right edge; width persisted) -------------
  const DEFAULT_SIDEBAR_WIDTH = 260;
  const MIN_SIDEBAR_WIDTH = 150;
  const MAX_SIDEBAR_WIDTH = 640;
  const LS_SIDEBAR_WIDTH = "autogallery.sidebarWidth";
  const clampSidebar = (w) =>
    Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(w)));
  let sidebarWidth = (() => {
    const stored = Number(localStorage.getItem(LS_SIDEBAR_WIDTH));
    return Number.isFinite(stored) && stored > 0
      ? clampSidebar(stored)
      : DEFAULT_SIDEBAR_WIDTH;
  })();
  $: localStorage.setItem(LS_SIDEBAR_WIDTH, String(sidebarWidth));
  let resizingSidebar = false;

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
  // Expanding a collapsed group must not move its header on screen: the header
  // holds the exact viewport offset it had at the click while the group's
  // photos grow downward below it (issue #74). Set to {key, offset} at expand
  // time and re-asserted on every layout recompute (like jumpRevealPending)
  // until the user takes over, because the focusId-recenter that re-fetches the
  // group replaces the whole feed window — so the header's grid Y is rebuilt
  // and a one-shot scroll can't hold it. Cleared on the user's first keypress/
  // wheel. Not a timer.
  let expandPin = null; // { key: string, offset: number } | null
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
  // "Open a folder…" text-input popover (non-native fallback when there's no
  // native folder picker). Kept separate from the ＋ add-folder `dir` state so
  // the two popovers don't clobber each other's input.
  let openFolderOpen = false;
  let openFolderDir = "";

  let selected = 0; // index into displayEntries; must never land on a
  // {kind:'placeholder'} entry — see nextSelectable below.
  let loupeOpen = false;
  let shortcutsHelpOpen = false; // '?' toggles the keyboard-shortcuts overlay
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
    // Show the version in the browser tab / Electron window title. Electron's
    // BrowserWindow title follows document.title by default, so this covers
    // both surfaces.
    document.title = `AutoGallery v${APP_VERSION}`;
    refreshLibrary();
    loadInitialFeed();
    refreshCounts();
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
    if (keepIds) exitKeepOnly();
    if (focusPath) exitFocus();
    onFilterChange({ ...DEFAULT_FILTER, dateAttr: filter.dateAttr });
  }

  // Human names of the currently-active filter facets, for the empty-state hint
  // (so it says exactly what's hiding the photos, not a generic list).
  $: activeFacetLabels = (() => {
    const f = [];
    if ((filter.minRating ?? 0) > 0) f.push(`${filter.minRating}+ stars`);
    const o = filter.orientations ?? [];
    if (o.length > 0 && o.length < 3) f.push("orientation");
    if (filter.dateFrom != null || filter.dateTo != null) f.push("time range");
    if (keepIds) f.push("keep-only scope");
    if (focusPath) f.push("folder focus");
    return f;
  })();

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
    if (globalViewMode === "expanded") {
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
      selectedIds = new Set([...selectedIds, ...ids]);
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
  let groupIdCache = new Map(); // pathKey -> { ids: number[], sig: string }
  let groupIdCacheVersion = 0; // bumped when the cache changes, to re-derive
  let groupIdInFlight = new Set(); // pathKeys mid-fetch (dedup)
  $: groupSelSig = JSON.stringify([displayFilter ?? null, sort ?? null]);
  // Drop cached group ids whenever the header/count caches reset — the one
  // signal (`countsEpoch`) that fires on every filter / keep-only / groupBy /
  // rescan / library-reset, i.e. exactly when a group's membership can change.
  let _groupCacheEpoch = 0;
  $: if (countsEpoch !== _groupCacheEpoch) {
    _groupCacheEpoch = countsEpoch;
    groupIdCache = new Map();
    groupIdInFlight = new Set();
    groupIdCacheVersion++;
  }

  /** Kick off a one-shot id fetch for a group whose ids aren't cached yet. */
  async function ensureGroupIds(path, key, sig) {
    if (groupIdInFlight.has(key)) return;
    groupIdInFlight.add(key);
    try {
      const ids = await fetchPhotoIds(
        filterIsActive(displayFilter) ? displayFilter : null,
        path,
        sort
      );
      groupIdCache.set(key, { ids, sig });
      groupIdCacheVersion++; // trigger the reactive re-derive
    } catch {
      // Leave uncached; a later render retries. The click path surfaces errors.
    } finally {
      groupIdInFlight.delete(key);
    }
  }

  /** Derive a group's select indicator. Reads reactive `_sel`/`_ver`/`_sig` as
   * args so Svelte re-runs this in the template when selection or cache change.
   * @returns {"none"|"some"|"all"|"loading"} */
  function groupSelectState(path, _sel, _ver, _sig) {
    const key = pathKey(path);
    const entry = groupIdCache.get(key);
    if (!entry || entry.sig !== _sig) {
      ensureGroupIds(path, key, _sig);
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
      selectedIds = new Set([...selectedIds, ...ids]);
      status = `Selected ${selectedIds.size.toLocaleString()} photo${
        selectedIds.size === 1 ? "" : "s"
      }`;
    } catch (e) {
      error = `Select all failed: ${e.message}`;
    }
  }

  /** Click the group's select icon: select-all, or deselect-all if already all. */
  async function toggleGroupSelectAll(path) {
    const key = pathKey(path);
    let entry = groupIdCache.get(key);
    if (!entry || entry.sig !== groupSelSig) {
      try {
        const ids = await fetchPhotoIds(
          filterIsActive(displayFilter) ? displayFilter : null,
          path,
          sort
        );
        entry = { ids, sig: groupSelSig };
        groupIdCache.set(key, entry);
        groupIdCacheVersion++;
      } catch (e) {
        error = e.message;
        return;
      }
    }
    const n = intersectionCount(entry.ids, selectedIds);
    if (selectState(n, entry.ids.length) === "all") {
      const next = new Set(selectedIds);
      for (const id of entry.ids) next.delete(id);
      selectedIds = next;
    } else {
      selectedIds = new Set([...selectedIds, ...entry.ids]);
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
      // Full refresh (feed + sidebar tree + counts) — same as the Manage
      // Library remove path. `loadInitialFeed()` alone left the removed
      // folder lingering in the sidebar (it only refetches on libraryVersion).
      await onFolderRemoved();
    } catch (e) {
      error = e.message;
    }
  }

  // --- Rename a folder group in place (issue #68 Slice B) ------------------
  // Inline-edit the folder's section header; commit renames the real folder on
  // disk and reloads the feed. `renamingKey` is the pathKey being edited.
  let renamingKey = null;
  let renameDraft = "";

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
      if (focusPath === folderPath) focusPath = newPath; // keep focus on it
      await loadInitialFeed();
      refreshCounts();
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
    // displayFilter is a `$:` derived value keyed on keepIds; it hasn't
    // recomputed yet. Flush reactive state before rebuilding so the feed loader
    // reads the keepScope filter (mirrors setFocus) — otherwise the live rebuild
    // fetches with the stale, unscoped filter and the focus window's "before"
    // half bleeds in the previous group's photos (#75). Symmetric on exit:
    // without the flush, leaving keep-only would rebuild while keepScope is
    // still true against an already-cleared scope.
    await tick();
    await onGroupByChange(groupBy);
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
      const ids = await fetchPhotoIds(null, path, sort);
      if (!ids.length) return;
      await applyKeepOnly(ids);
    } catch (e) {
      error = e.message;
    }
  }

  /** Leave keep-only focus, back to the whole library. */
  function exitKeepOnly() {
    applyKeepOnly(null);
  }

  /** Enter/replace folder-focus on a subtree path (null exits). Mirrors
   * applyKeepOnly's refresh sequence so the feed/tree/counts all rebuild against
   * the new displayFilter — routes through onGroupByChange (the shared feed-window
   * guard) rather than hand-rolling a window reset. Folder-focus and keep-only are
   * both "scope the whole app to a subset"; stacking them is confusing and "keep it
   * alone" implies a clean scope, so entering focus clears any active keep-only. */
  async function setFocus(path) {
    focusPath = path || null;
    if (keepIds) {
      keepIds = null;
      setScope([]).catch(() => {}); // fire-and-forget the server-side clear
    }
    countsEpoch++;
    headerCounts = {};
    fetchedParents = new Set();
    inFlightParents = new Set();
    // displayFilter is a `$:` derived value; it hasn't recomputed with the new
    // focusPath yet. Flush reactive state before rebuilding so the feed loader
    // reads the updated filter (otherwise the live rebuild uses the stale,
    // unfocused filter and the grid keeps showing out-of-scope folders).
    await tick();
    await onGroupByChange(groupBy);
    refreshCounts();
    libraryVersion++; // force TreeSidebar/Fisheye (refreshToken) to refetch
  }

  /** Leave folder-focus, back to the whole library. */
  function exitFocus() {
    setFocus(null);
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
  // --- Right-click context menu (issue #18; shared surface for #25) ---------
  // `targetIndex` indexes displayEntries, like `selected`.
  let contextMenu = { open: false, x: 0, y: 0, targetIndex: -1 };

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
      status = `Couldn't reveal file: ${res.error ?? "unknown error"}`;
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
      status = `Couldn't reveal selection: ${res.error ?? "unknown error"}`;
      console.warn("[reveal-selection]", res.error);
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
  $: revealTargetId = resolvedPhotos[contextMenu.targetIndex]?.id;
  // Reveal the whole selection when the right-clicked photo is part of a
  // multi-selection (like a file manager); otherwise reveal just that photo.
  $: revealWholeSelection =
    selectedIds.size > 1 &&
    typeof revealTargetId === "number" &&
    selectedIds.has(revealTargetId);
  $: contextMenuItems = [
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
  ];

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
    if (selected === i) openLoupe(i);
    else selected = i;
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
    keepIds = null;
    focusPath = null; // the focused folder is gone with the whole index
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
      selected = nextSelectable(displayEntries, 0, 1) ?? 0;
      loupeOpen = false;
      focusPending = true;
      status = `${items.length} photo${items.length === 1 ? "" : "s"} loaded`;
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
  $: hereIndex =
    selected >= renderStart && selected <= renderEnd ? selected : renderStart;
  $: currentPath = deriveCurrentPath(hereIndex, displayEntries, groupBy);

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
  $: currentFolder =
    focusPath ||
    folderFromGroupPath(currentPath) ||
    albumFirstPhotoFolder ||
    null;
  $: currentFolderName = currentFolder
    ? currentFolder.split(/[/\\]/).filter(Boolean).pop()
    : "";

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
  $: focusTime = deriveCurrentTime(selected, displayEntries, filter.dateAttr);
  $: viewTime = deriveCurrentTime(renderStart, displayEntries, filter.dateAttr);
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
  $: focusMarkerTime = clampMarker(focusTime, filterMode, filter);
  $: viewMarkerTime = clampMarker(viewTime, filterMode, filter);

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

  async function toggleSectionCollapse(path) {
    const key = pathKey(path);
    const collapsing = !collapsedPaths.some((p) => pathKey(p) === key);
    // Expanding: remember where this group's header sits right now, and arm the
    // pin BEFORE the refetch — recenterFeedOnId sets focusPending, whose focus()
    // would otherwise scroll to `selected`; the pin's presence turns that scroll
    // off (preventScroll) and holds the header in place instead (issue #74).
    if (!collapsing) {
      const offset = groupAnchorOffset(key);
      expandPin = offset == null ? null : { key, offset };
    }
    collapsedPaths = collapsing
      ? [...collapsedPaths, path]
      : collapsedPaths.filter((p) => pathKey(p) !== key);
    // Expand seeks to the group's own first photo (loads from the top, extends
    // downward via loadMore("after")); collapse re-centers on the current
    // selection, excluding the group about to be hidden.
    const focusId = collapsing
      ? safeFocusId(selected, path)
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
  let seenRestart = 0;
  startServerWatchdog();
  $: if ($serverRestarted > seenRestart) {
    seenRestart = $serverRestarted;
    onServerBack();
  }
  async function onServerBack() {
    try {
      libraryVersion++; // sidebars refetch
      await refreshCounts();
      await loadInitialFeed();
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
  let lastUncaught = "";
  function reportUncaught(kind, err) {
    const msg = err?.message ?? String(err ?? "unknown error");
    if (msg === lastUncaught) return;
    lastUncaught = msg;
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
      ids = await fetchPhotoIds(
        filterIsActive(displayFilter) ? displayFilter : null,
        path,
        sort
      );
    } catch (e) {
      error = `Couldn't jump: ${e.message}`;
      return;
    }
    if (!ids.length) return;
    const anchor = direction === "next" ? ids.at(-1) : ids[0];
    await jumpGroupBoundary(direction, anchor);
  }

  /** A group's current FEED state, for the shared GroupStateIcon. `_collapsed`
   * and `_snapshots` are taken as ARGS (not closed over) so Svelte's dependency
   * tracking — which reads the expression's source text — actually re-runs this
   * in the template when either changes. Same reasoning as TreeNode's
   * collapsedInFeed. @returns {"expanded"|"snapshot"|"collapsed"} */
  function feedGroupState(path, _collapsed, _snapshots) {
    const key = pathKey(path);
    if (!_collapsed.some((p) => pathKey(p) === key)) return "expanded";
    return _snapshots.has(key) ? "snapshot" : "collapsed";
  }

  const GROUP_STATE_TITLE = {
    expanded: "Photos showing in full — click for a snapshot strip",
    snapshot: "Showing a snapshot strip — click to collapse",
    collapsed: "Collapsed — click to show the photos again",
  };

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
    const key = pathKey(path);
    const isCollapsed = collapsedPaths.some((p) => pathKey(p) === key);
    const isSnapshot = snapshotGroupKeys.has(key);
    if (!isCollapsed) {
      // Aggregating a parent SUPERSEDES whatever its descendants were doing.
      // Without this, a leaf that was already snapshotted kept its own entry and
      // the feed drew a second strip inside the parent's one.
      collapsedPaths = collapsedPaths.filter(
        (p) => !isPathUnder(p, path) || pathKey(p) === key
      );
      snapshotGroupKeys = new Set(
        [...snapshotGroupKeys].filter((k) => !isKeyUnder(k, path) || k === key)
      );
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

  // --- Shift+click a parent = fold its LEAVES (VS Code function folding) -----
  // Plain click on a parent aggregates it (collapse/snapshot the parent as one
  // block). Shift+click instead applies the state to every LEAF underneath, so
  // the parent stays open and you see its subgroups as folded rows.
  const MAX_FOLD_LEAVES = 400;

  /** Is `p` (an Array<{dimension,value}>) at or beneath `parent`? */
  function isPathUnder(p, parent) {
    if (!Array.isArray(p) || p.length < parent.length) return false;
    return parent.every(
      (seg, i) => p[i]?.dimension === seg.dimension && p[i]?.value === seg.value
    );
  }
  /** Same test, but for a snapshotGroupKeys entry (a pathKey string: [[dim,val],…]). */
  function isKeyUnder(key, parent) {
    let pairs;
    try {
      pairs = JSON.parse(key);
    } catch {
      return false;
    }
    if (!Array.isArray(pairs) || pairs.length < parent.length) return false;
    return parent.every(
      (seg, i) => pairs[i]?.[0] === seg.dimension && pairs[i]?.[1] === seg.value
    );
  }

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

  /** Shift+click on a group with subgroups: cycle ALL of its leaves together. */
  async function cycleGroupLeaves(path) {
    if (path.length >= groupBy.length) return cycleGroupState(path); // already a leaf
    let leaves;
    try {
      leaves = await collectLeafPaths(path);
    } catch (e) {
      error = `Couldn't fold the subgroups: ${e.message}`;
      return;
    }
    if (!leaves.length) return cycleGroupState(path); // nothing beneath → aggregate
    if (leaves.length > MAX_FOLD_LEAVES) {
      error = `That group has more than ${MAX_FOLD_LEAVES} subgroups — too many to fold at once. Collapse it as a whole instead (click without Shift).`;
      return;
    }

    // Next state, from where the leaves collectively are now (all-expanded →
    // snapshot → collapsed → expanded). A mixed set resets to expanded.
    const states = leaves.map((lp) =>
      feedGroupState(lp, collapsedPaths, snapshotGroupKeys)
    );
    const next = states.every((s) => s === "expanded")
      ? "snapshot"
      : states.every((s) => s === "snapshot")
        ? "collapsed"
        : "expanded";

    // Drop any existing state inside this subtree (including the parent's own
    // aggregate collapse), then apply the new state to the leaves.
    const nextCollapsed = collapsedPaths.filter((p) => !isPathUnder(p, path));
    const nextSnaps = new Set(
      [...snapshotGroupKeys].filter((k) => !isKeyUnder(k, path))
    );
    if (next !== "expanded") {
      for (const lp of leaves) {
        nextCollapsed.push(lp);
        if (next === "snapshot") nextSnaps.add(pathKey(lp));
      }
    }
    collapsedPaths = nextCollapsed;
    snapshotGroupKeys = nextSnaps;
    try {
      await loadInitialFeed();
    } catch (e) {
      error = e.message;
    }
  }

  /** Entry point for every group toggle (feed header + tree icon): Shift folds
   * the leaves, a plain click aggregates the group itself. */
  function onGroupToggle(path, event) {
    return event?.shiftKey ? cycleGroupLeaves(path) : cycleGroupState(path);
  }

  /** Set collapsedPaths / snapshotGroupKeys so EVERY current top-level group
   * matches `mode`: "expanded" clears both; "snapshot"/"collapsed" collapse all
   * top-level groups (snapshot also renders each as a strip). Fetches the current
   * top-level group list under displayFilter. Does NOT rebuild the feed — the
   * caller reloads after. Reused by the cycle-all control AND by filter/sort
   * rebuilds so a global view mode survives those changes (new groups inherit it). */
  async function applyViewModeToGroups(mode) {
    if (mode === "expanded") {
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
      mode === "snapshot" ? new Set(allPaths.map(pathKey)) : new Set();
  }

  /** The top-of-toolbar "cycle all" control: flip EVERY top-level group at
   * once through full view → snapshot all → collapse all → full view. Sets
   * collapsedPaths / snapshotGroupKeys wholesale and rebuilds the feed from the top. */
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
      await applyViewModeToGroups(next);
      globalViewMode = next;
      await loadInitialFeed();
    } catch (e) {
      error = e.message;
    } finally {
      cyclingAll = false;
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
   * own reveal/pin scrolling (issue #74); no-op when the tile isn't in the DOM. */
  function focusTile(id, { preventScroll = false } = {}) {
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
  let handledUndoJobs = new Set();
  $: if (takeNewlyFinished($jobs, "undo-move", handledUndoJobs).length) {
    onFolderRemoved();
  }

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
    } catch (e) {
      error = e.message;
      status = "";
    } finally {
      albumMode = false;
    }
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

  /** "Open a folder" focus. If the subtree is already indexed, focus straight
   * from the cache (works offline — an unmounted volume can't be rescanned).
   * Otherwise scan it in recursively (the same background-job flow as the ＋
   * add-folder path) so it becomes a permanent library member, then focus. */
  async function openFolderFocus(path) {
    const p = (path || "").trim();
    if (!p) return;
    const alreadyIndexed = library.some(
      (e) => e.path === p || e.path.startsWith(p + "/")
    );
    error = "";
    try {
      if (!alreadyIndexed) {
        scanning = true;
        status = "scanning…";
        const { jobId } = await startScan(p, { recursive: true });
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
        localStorage.setItem(LS_KEY, p);
        await refreshLibrary();
      }
      setFocus(p);
      status = "";
    } catch (e) {
      error = e.message;
      status = "";
    } finally {
      scanning = false;
    }
  }

  /** Toolbar "Open a folder…" entry: get a path (native picker when available,
   * otherwise a small text-input popover) and hand it to openFolderFocus. */
  function requestOpenFolder() {
    libraryOpen = false;
    if (hasNativePicker) {
      window.autogallery?.pickFolder().then((path) => {
        if (path) openFolderFocus(path);
      });
    } else {
      openFolderDir = "";
      openFolderOpen = true;
    }
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
  // One nesting step, shared by the layout (photo indent) and the CSS (header
  // indent + dendrogram trunk), so the lines and the photos agree.
  const GROUP_INDENT = 18;
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

  $: autoStacks = detectBurstsByGroup(items, groupBy, {
    gapMs: burstEnabled ? burstGapMs : 0,
  });
  // Fold in the persisted manual create/dissolve overrides (issue #24) — all
  // logic lives in ui/src/lib/stackOverrides.js; this is the only stacks change.
  $: stacks = applyStackOverrides(autoStacks, items);
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
            // Nest the CONTENT, not just the header: photos of a sub-group are
            // inset to sit under their own header. Same step as the header
            // indent (--ind) so the dendrogram lines up with the photos.
            indentPerDepth: GROUP_INDENT,
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
  // Same re-pin story for an expanded group's header (see expandPin): the
  // refetch + metadata reflow keep moving it until the layout settles.
  $: if (expandPin && boxes) scheduleExpandPin();
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
  $: visibleItems = buildVisibleItems(
    displayEntries,
    renderStart,
    renderEnd,
    selected
  );

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
      // preventScroll while a group is being expanded: focusing the selected
      // tile must not yank the viewport off the header the expand pin is holding
      // (issue #74). Normal scans/jumps (no pin) keep the focus-reveal scroll.
      focusTile(entry ? resolvePhoto(entry).id : null, {
        preventScroll: !!expandPin,
      });
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
    // NOTE: we intentionally do NOT exit album mode here. When you click a photo
    // in the Auto-albums snapshot strips, the loupe opens as an overlay on top
    // of the still-mounted AlbumsView; pressing Esc closes the loupe and returns
    // you to the album review with all your split/naming/materialize state
    // intact (previously this set albumMode=false, unmounting AlbumsView and
    // discarding that work — the in-feed redesign in #81 supersedes this).
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
    focusTile(entry ? resolvePhoto(entry).id : null);
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
    expandedStackIds.add(stack.id);
    expandedStackIds = expandedStackIds; // trigger reactivity
    await tick();
    const newIndex = displayEntries.findIndex(
      (e) => e.kind === "photo" && e.item.id === stack.coverId
    );
    if (newIndex !== -1) {
      selected = newIndex;
      await tick();
      focusTile(stack.coverId, { preventScroll: true });
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
    if (renderStart <= FETCH_THRESHOLD && !jumpRevealPending && !expandPin) {
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
    // Cmd/Ctrl+A selects every photo in the current working set (the same
    // whole-set query the group select-all and export use). Handled before the
    // blanket meta/ctrl bail below, but only when focus isn't in a text field —
    // there, Cmd/Ctrl+A must still select the field's text.
    if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable)
        return;
      e.preventDefault();
      await selectAllInView();
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
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable)
      return;

    // '?' opens the keyboard-shortcuts overlay (before the empty-library
    // guard, so it works even with nothing scanned yet).
    if (e.key === "?") {
      e.preventDefault();
      shortcutsHelpOpen = true;
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
          sort
        );
      } catch (err) {
        error = err.message;
        return;
      }
      const edgeId = direction === "next" ? ids.at(-1) : ids[0];
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
  on:keydown={onKeydown}
  on:resize={scheduleVisibleRangeUpdate}
  on:error={(e) => reportUncaught("display", e.error ?? e.message)}
  on:unhandledrejection={(e) => reportUncaught("background", e.reason)}
/>

<UpdateBanner />

<ServerBanner />

<div class="app">
  <header class="topbar">
    <h1>
      AutoGallery
      <span class="app-version" title="App version">v{APP_VERSION}</span>
    </h1>

    <!-- ① SOURCE -->
    <SourceControls
      {scanning}
      {hasNativePicker}
      bind:libraryOpen
      bind:manageLibraryOpen
      bind:addFolderOpen
      bind:dir
      bind:recursiveScan
      bind:openFolderOpen
      bind:openFolderDir
      on:openfolder={requestOpenFolder}
      on:scan={doScan}
      on:choosefolder={chooseFolder}
      on:openfolderfocus={() => openFolderFocus(openFolderDir)}
    />

    <div class="divider"></div>

    <!-- ② ORGANIZE & FILTER -->
    <OrganizeControls
      {groupBy}
      {filter}
      {filterMode}
      {timeMin}
      {timeMax}
      {timeTimes}
      viewTime={viewMarkerTime}
      focusTime={focusMarkerTime}
      on:groupbychange={(e) => onGroupByChange(e.detail)}
      on:filtermodechange={(e) => onFilterModeChange(e.detail)}
      on:filterchange={(e) => onFilterChange(e.detail)}
    />

    <div class="divider push"></div>

    <!-- ③ VIEW -->
    <ViewControls
      bind:sidebarMode
      {cyclingAll}
      {globalViewMode}
      bind:albumMode
      {detectingAlbums}
      on:revealcurrent={revealCurrentLocation}
      on:cycleall={cycleAllGroups}
      on:detectalbums={detectAlbums}
    />

    {#if keepIds}
      <button
        class="keep-chip"
        on:click={exitKeepOnly}
        title="Exit keep-only focus (back to the whole library)"
      >
        ● Keep-only {keepIds.length.toLocaleString()} ✕
      </button>
    {/if}

    {#if focusPath}
      <button
        class="focus-chip"
        on:click={exitFocus}
        title={"Exit folder focus — back to the whole library (" +
          focusPath +
          ")"}
      >
        ▣ Focused: {focusName} ✕
      </button>
    {/if}

    <SelectionBar
      {selectedCount}
      {lastClearedSelection}
      {hasNativePicker}
      {exporting}
      {exportResult}
      bind:exportOpen
      bind:exportDest
      bind:exportName
      on:clear={clearSelection}
      on:keeponly={keepOnlySelection}
      on:undoclear={undoClearSelection}
      on:choosedest={chooseExportDest}
      on:export={doExport}
    />

    <button
      class="help-btn"
      title="Keyboard shortcuts (?)"
      aria-label="Keyboard shortcuts"
      on:click={() => (shortcutsHelpOpen = true)}
    >
      ?
    </button>
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
          on:toggle={(e) => onGroupToggle(e.detail.path, e.detail.event)}
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
    </div>
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <div
      class="sidebar-resizer"
      class:dragging={resizingSidebar}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar (double-click to reset)"
      tabindex="0"
      title="Drag to resize the sidebar (double-click to reset)"
      on:pointerdown={startSidebarResize}
      on:dblclick={() => (sidebarWidth = DEFAULT_SIDEBAR_WIDTH)}
      on:keydown={onSidebarResizeKey}
    ></div>
    <div
      class="main-column"
      bind:this={mainColumnEl}
      on:scroll={scheduleVisibleRangeUpdate}
      on:wheel={() => ((jumpRevealPending = false), (expandPin = null))}
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
          on:relimit={(e) => onAlbumRelimit(e.detail)}
          on:close={() => (albumMode = false)}
          on:openphoto={(e) => openPhotoById(e.detail.id)}
          on:prefschange={(e) => (albumPrefs = saveAlbumPrefs(e.detail))}
          on:materialized={(e) => onAlbumsMaterialized(e.detail)}
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
                style="--depth:{header.depth}; top:{header.y}px; height:{header.endY -
                  header.y}px;"
              >
                <div
                  class="section-header"
                  style="top:{header.depth * HEADER_HEIGHT}px; z-index:{15 -
                    header.depth};"
                >
                  <button
                    class="section-toggle-icon {header.path
                      ? feedGroupState(
                          header.path,
                          collapsedPaths,
                          snapshotGroupKeys
                        )
                      : 'expanded'}"
                    title={GROUP_STATE_TITLE[
                      header.path
                        ? feedGroupState(
                            header.path,
                            collapsedPaths,
                            snapshotGroupKeys
                          )
                        : "expanded"
                    ]}
                    aria-label="Cycle this group: full grid → snapshot strip → collapsed"
                    on:click={(e) =>
                      onGroupToggle(
                        header.path ??
                          groupBy.slice(0, header.depth + 1).map((d) => ({
                            dimension: d,
                            value: resolvedPhotos[header.index]?.groupValues[d],
                          })),
                        e
                      )}
                  >
                    <GroupStateIcon
                      state={header.path
                        ? feedGroupState(
                            header.path,
                            collapsedPaths,
                            snapshotGroupKeys
                          )
                        : "expanded"}
                    />
                  </button>
                  {#if header.path && renamingKey === pathKey(header.path)}
                    <!-- svelte-ignore a11y-autofocus -->
                    <input
                      class="section-rename"
                      bind:value={renameDraft}
                      on:click|stopPropagation
                      on:keydown={(e) => {
                        if (e.key === "Enter") commitRename(header.path);
                        else if (e.key === "Escape") cancelRename();
                      }}
                      on:blur={() => commitRename(header.path)}
                      autofocus
                    />
                  {:else}
                    <button
                      class="section-label"
                      title={header.path?.at(-1)?.dimension === "folder"
                        ? "Double-click to rename this folder on disk"
                        : ""}
                      on:dblclick={() => startRename(header.path)}
                    >
                      {header.label}
                    </button>
                  {/if}
                  {#if header.path && headerCounts[pathKey(header.path)] !== undefined}
                    <span class="section-count">
                      {headerCounts[pathKey(header.path)].toLocaleString()} items
                    </span>
                  {/if}
                  {#if header.path}
                    <GroupLabelActions
                      selectState={groupSelectState(
                        header.path,
                        selectedIds,
                        groupIdCacheVersion,
                        groupSelSig
                      )}
                      isFolder={isRemovableFolder(header.path)}
                      removeArmed={removeArmedKey === pathKey(header.path)}
                      on:toggleselect={() => toggleGroupSelectAll(header.path)}
                      on:keeponly={() => keepOnlyGroup(header.path)}
                      on:jumpprev={() => jumpFromGroup(header.path, "prev")}
                      on:jumpnext={() => jumpFromGroup(header.path, "next")}
                      on:remove={() => removeAlbum(header.path)}
                    />
                  {/if}
                </div>
              </div>
            {/each}
            {#each visibleItems as { i, entry } (entryDomId(entry))}
              {#if entry.kind === "placeholder"}
                {#if snapshotGroupKeys.has(pathKey(entry.item.path))}
                  <div
                    class="snapshot-row"
                    data-group-key={pathKey(entry.item.path)}
                    style="top:{boxes[i].y}px; left:{boxes[i]
                      .x}px; width:{boxes[i].width}px; height:{boxes[i]
                      .height}px;"
                  >
                    <div class="snapshot-head">
                      <button
                        class="snap-cycle snapshot"
                        title={GROUP_STATE_TITLE.snapshot}
                        aria-label="Cycle this group: full grid → snapshot strip → collapsed"
                        on:click|stopPropagation={(e) =>
                          onGroupToggle(entry.item.path, e)}
                      >
                        <GroupStateIcon state="snapshot" />
                      </button>
                      <span
                        class="snapshot-label"
                        title={entry.item.path
                          .map((p) => formatGroupValue(p.dimension, p.value))
                          .join(" / ")}
                      >
                        {entry.item.path
                          .map((p) => formatGroupValue(p.dimension, p.value))
                          .join(" / ")}
                      </span>
                      <span class="section-count">
                        {entry.item.count.toLocaleString()} items
                      </span>
                      <GroupLabelActions
                        selectState={groupSelectState(
                          entry.item.path,
                          selectedIds,
                          groupIdCacheVersion,
                          groupSelSig
                        )}
                        isFolder={isRemovableFolder(entry.item.path)}
                        removeArmed={removeArmedKey ===
                          pathKey(entry.item.path)}
                        on:toggleselect={() =>
                          toggleGroupSelectAll(entry.item.path)}
                        on:keeponly={() => keepOnlyGroup(entry.item.path)}
                        on:jumpprev={() =>
                          jumpFromGroup(entry.item.path, "prev")}
                        on:jumpnext={() =>
                          jumpFromGroup(entry.item.path, "next")}
                        on:remove={() => removeAlbum(entry.item.path)}
                      />
                    </div>
                    <div class="snap-wrap">
                      <SnapshotStrip
                        groupPath={entry.item.path}
                        count={entry.item.count}
                        filter={displayFilter}
                        {sort}
                        {groupBy}
                        thumbPx={SNAPSHOT_ROW_HEIGHT - 44}
                        size={snapshotThumbSize}
                        on:select={(e) =>
                          openPhotoById(e.detail.id, entry.item.path)}
                      />
                    </div>
                  </div>
                {:else}
                  <div
                    class="placeholder-row"
                    data-group-key={pathKey(entry.item.path)}
                    style="top:{boxes[i].y}px; left:{boxes[i]
                      .x}px; width:{boxes[i].width}px; height:{boxes[i]
                      .height}px;"
                    role="button"
                    tabindex="0"
                    on:click={(e) => onGroupToggle(entry.item.path, e)}
                    on:keydown={(e) =>
                      e.key === "Enter" && onGroupToggle(entry.item.path, e)}
                  >
                    <span
                      class="placeholder-icon"
                      title={GROUP_STATE_TITLE.collapsed}
                      ><GroupStateIcon state="collapsed" /></span
                    >
                    <span class="placeholder-label">
                      {entry.item.path
                        .map((p) => formatGroupValue(p.dimension, p.value))
                        .join(" / ")}
                    </span>
                    <span class="placeholder-count">
                      {entry.item.count.toLocaleString()} items
                    </span>
                    <GroupLabelActions
                      selectState={groupSelectState(
                        entry.item.path,
                        selectedIds,
                        groupIdCacheVersion,
                        groupSelSig
                      )}
                      isFolder={isRemovableFolder(entry.item.path)}
                      removeArmed={removeArmedKey === pathKey(entry.item.path)}
                      on:toggleselect={() =>
                        toggleGroupSelectAll(entry.item.path)}
                      on:keeponly={() => keepOnlyGroup(entry.item.path)}
                      on:jumpprev={() => jumpFromGroup(entry.item.path, "prev")}
                      on:jumpnext={() => jumpFromGroup(entry.item.path, "next")}
                      on:remove={() => removeAlbum(entry.item.path)}
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
                  on:click={(e) => onTileClick(e, entry, i)}
                  on:toggleselect={() => toggleSelect(resolvePhoto(entry)?.id)}
                  on:contextmenu={(e) => onTileContextMenu(e, entry, i)}
                  on:attempt={handleThumbAttempt}
                  on:settled={handleThumbSettled}
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
              on:click={() =>
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
            <button class="empty-action" on:click={clearAllFilters}
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
  </div>

  <!-- In the app's flex column, directly above the status bar: the jobs strip
       takes its own space (up to 40vh) and the grid shrinks to fit, so an
       active job never paints over the status bar (it used to be fixed at
       bottom:0 and cover it). -->
  <JobsPanel />

  <StatusBar
    {libraryTotal}
    {showingCount}
    {selectedCount}
    {status}
    {error}
    {thumbProgress}
    {thumbCounts}
    bind:zoom
    zoomMax={ZOOM_LEVELS.length - 1}
    bind:burstEnabled
    bind:burstGapMs
    {sort}
    on:sortchange={(e) => onSortChange(e.detail)}
  />
</div>

{#if loupeOpen}
  <Loupe
    items={resolvedPhotos}
    bind:index={selected}
    inSelection={typeof resolvedPhotos[selected]?.id === "number" &&
      selectedIds.has(resolvedPhotos[selected].id)}
    {selectedCount}
    {selectedIds}
    showDetails={showLoupeDetails}
    showFilmstrip={showLoupeFilmstrip}
    on:contextmenu={(e) => openContextMenu(e.detail.x, e.detail.y, selected)}
    on:close={closeLoupe}
    on:rate={(e) => rate(selected, e.detail)}
    on:toggleselect={() => toggleSelect(resolvedPhotos[selected]?.id)}
  />
{/if}

{#if contextMenu.open}
  <ContextMenu
    x={contextMenu.x}
    y={contextMenu.y}
    items={contextMenuItems}
    on:close={() => (contextMenu.open = false)}
  />
{/if}

{#if shortcutsHelpOpen}
  <ShortcutsOverlay on:close={() => (shortcutsHelpOpen = false)} />
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
  /* Folder-focus chip — a distinct blue/violet accent so it reads as a
     different kind of scope than the green keep-only chip. */
  .focus-chip {
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
  .focus-chip:hover {
    background: #263562;
  }
  h1 {
    font-size: 1rem;
    font-weight: 600;
    margin: 0;
    color: #fff;
    white-space: nowrap;
  }
  .app-version {
    font-size: 0.7rem;
    font-weight: 500;
    color: #7a7a7a;
    margin-left: 2px;
    vertical-align: 0.15em;
  }
  .help-btn {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1px solid #3a3a3a;
    background: #262626;
    color: #cfcfcf;
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: 0.25rem;
  }
  .help-btn:hover {
    background: #333;
    color: #fff;
    border-color: #555;
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
  /* Nesting is drawn as a dendrogram: each level is indented, a dotted trunk runs
     down the sub-group's spine, and a dotted elbow joins each child header to it
     — so a sub-group visibly belongs to the group above instead of floating as
     just another header. `--depth` is set on the wrapper; custom properties
     inherit, so the header reads it from there. */
  .section-wrapper {
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
    /* Must beat the section headers (z-index 15): they are sticky with an OPAQUE
       background, so at 'auto' the trunk was painted over wherever a header sat
       and the elbows looked like floating stubs. It runs up the header's left
       padding gutter, which the per-depth padding reserves. */
    z-index: 16;
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
    z-index: 16;
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
  .section-toggle-icon.snapshot,
  .section-toggle-icon.collapsed {
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
  /* The group actions (Select/Keep only/Remove) live in GroupLabelActions
     (issue #88); its select icon is always visible, but its action buttons
     (.gla-buttons) reveal only on hover of the surrounding header row. The
     reveal target crosses the component boundary, so it's a :global rule keyed
     on each of the three header states. */
  .section-header:hover :global(.gla-buttons),
  .section-header:focus-within :global(.gla-buttons),
  .snapshot-head:hover :global(.gla-buttons),
  .snapshot-head:focus-within :global(.gla-buttons),
  .placeholder-row:hover :global(.gla-buttons),
  .placeholder-row:focus-within :global(.gla-buttons) {
    opacity: 1;
  }
  /* left/width come from the layout's content rect (boxes[i]), so a nested
     group's row is inset under its header like its photos are. */
  .snapshot-row {
    position: absolute;
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
    padding: 3px 8px;
    display: inline-flex;
    align-items: center;
  }
  .snap-cycle.snapshot {
    color: #ffd24c;
  }
  /* The collapsed pill's leading glyph is the same shared state icon. */
  .placeholder-icon {
    display: inline-flex;
    align-items: center;
    color: #ffd24c;
    flex: 0 0 auto;
  }
  /* left/width come from the layout's content rect (boxes[i]) — see .snapshot-row. */
  .placeholder-row {
    position: absolute;
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
