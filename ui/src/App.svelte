<script>
  import { onMount, tick } from "svelte";
  import { sectionedJustifiedLayout } from "./lib/layouts/sectionedJustified.js";
  import { visibleRange } from "./lib/layouts/windowing.js";
  import { revealScrollTop } from "./lib/scroll.js";
  import { detectBurstsByGroup } from "./lib/bursts.js";
  import { nextSelectable, navVertical } from "./lib/navigation.js";
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
    const focusId = safeFocusId(selected);
    error = "";
    status = "loading…";
    const epoch = ++feedEpoch;
    // See loadInitialFeed's comment: blocks a concurrent scroll-triggered
    // loadMore from splicing a stale page into the window this replaces.
    fetchingBefore = true;
    fetchingAfter = true;
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
        ? dedupeById([...beforePage, ...(focusItem ? [focusItem] : []), ...afterPage])
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
        ? findEntryIndexForId(displayEntries, focusId)
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
    } finally {
      fetchingBefore = false;
      fetchingAfter = false;
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

  /** Finds the displayEntries index whose entry represents photo `id` —
   * either directly (a plain photo entry, or a stack entry whose cover IS
   * id), or as a collapsed stack's non-cover member. resolvePhoto(entry)
   * only ever returns a stack's cover photo, so `resolvePhoto(e).id ===
   * id` alone can never match a member id that isn't the cover — a
   * server-resolved focusId/targetId lands on whichever raw photo the
   * seek found, with no awareness of this client-side burst grouping, so
   * it can legitimately be a hidden member. Landing on that member's
   * stack (showing its cover) is the correct behavior, not a fallback. */
  function findEntryIndexForId(entries, id) {
    return entries.findIndex((e) =>
      e.kind === "stack" ? e.stack.memberIds.includes(id) : resolvePhoto(e).id === id
    );
  }

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

  /** Toggle a section's collapsed state and re-center the feed on whatever
   * photo is currently selected, so the user doesn't lose their place —
   * mirrors onGroupByChange's re-centering. */
  async function toggleSectionCollapse(path) {
    const key = pathKey(path);
    const collapsing = !collapsedPaths.some((p) => pathKey(p) === key);
    collapsedPaths = collapsing
      ? [...collapsedPaths, path]
      : collapsedPaths.filter((p) => pathKey(p) !== key);

    const focusId = safeFocusId(selected, collapsing ? path : null);
    error = "";
    status = "loading…";
    const epoch = ++feedEpoch;
    // See loadInitialFeed's comment: blocks a concurrent scroll-triggered
    // loadMore from splicing a stale page into the window this replaces —
    // collapsing a large section can shrink the rendered grid enough that
    // the current scroll position crosses loadMore's own auto-fetch
    // threshold, firing it while this function's own fetch is in flight.
    fetchingBefore = true;
    fetchingAfter = true;
    try {
      const { items: beforePage } = focusId
        ? await fetchFeed({
            groupBy,
            collapsed: collapsedPaths,
            focusId,
            before: PAGE_SIZE / 2,
            after: 0,
          })
        : { items: [] };
      const { items: afterPage, focusItem } = await fetchFeed({
        groupBy,
        collapsed: collapsedPaths,
        focusId,
        before: 0,
        after: focusId ? PAGE_SIZE / 2 : PAGE_SIZE,
      });
      if (epoch !== feedEpoch) return;
      const combined = focusId
        ? dedupeById([...beforePage, ...(focusItem ? [focusItem] : []), ...afterPage])
        : afterPage;
      items = combined;
      hasMoreBefore = focusId ? beforePage.length >= PAGE_SIZE / 2 : false;
      hasMoreAfter = afterPage.length >= (focusId ? PAGE_SIZE / 2 : PAGE_SIZE);
      await tick();
      const focusIndex = focusId ? findEntryIndexForId(displayEntries, focusId) : -1;
      selected =
        focusIndex !== -1 ? focusIndex : (nextSelectable(displayEntries, 0, 1) ?? 0);
      focusPending = true;
      status = `${items.length} photo${items.length === 1 ? "" : "s"} loaded`;
      enrichMeta(items.map((i) => i.id));
    } catch (e) {
      error = e.message;
      status = "";
    } finally {
      fetchingBefore = false;
      fetchingAfter = false;
    }
  }

  /** Scroll mainColumnEl so the currently-selected tile is visible — called
   * ONLY from active navigation (keyboard, group-jump), never from a reflow or
   * a programmatic re-anchor. Reads the tile's live DOM rect (buildVisibleItems
   * always mounts `selected`, so it exists after a tick), which avoids any
   * content-vs-client coordinate mismatch. No-op if the tile isn't mounted.
   *
   * `align: "nearest"` (default, for keyboard nav) scrolls the minimum needed
   * and is a no-op when already fully visible — never re-centers. `align:
   * "top"` (for a group-jump) pins the tile just below the sticky-header band
   * so the newly-landed group reads from the top; a jump lands somewhere the
   * user can't see, so "just barely in view" isn't enough there.
   *
   * Scrolls INSTANTLY, not smoothly: a smooth scroll here is silently
   * cancelled by the reflow the same navigation triggers (selection change →
   * re-layout → the animation never lands, confirmed live), and instant is
   * also snappier for fast keyboard culling.
   * @param {{align?: "nearest"|"top"}} [opts]
   */
  function revealSelected({ align = "nearest" } = {}) {
    if (!gridEl || !mainColumnEl) return;
    const entry = displayEntries[selected];
    const tile =
      entry && gridEl.querySelector(`[data-id="${resolvePhoto(entry).id}"]`);
    if (!tile) return;
    const tileRect = tile.getBoundingClientRect();
    const contRect = mainColumnEl.getBoundingClientRect();
    // Express the tile's top in the same scrollTop-based coordinate the
    // viewport uses, so the math compares like with like.
    const boxTop = mainColumnEl.scrollTop + (tileRect.top - contRect.top);
    // Reserve the worst-case sticky-header stack (one band per grouping level)
    // so a tile at a section boundary isn't revealed underneath the headers.
    const margin = HEADER_HEIGHT * groupBy.length;
    let target;
    if (align === "top") {
      target = boxTop - margin;
      // Skip a scroll that wouldn't meaningfully move (avoids jitter when
      // scrollToSection already landed the tile at the top).
      if (Math.abs(target - mainColumnEl.scrollTop) < 2) return;
    } else {
      target = revealScrollTop(
        { top: boxTop, height: tileRect.height },
        mainColumnEl.scrollTop,
        mainColumnEl.clientHeight,
        margin
      );
    }
    if (target != null) {
      mainColumnEl.scrollTo({ top: Math.max(0, target), behavior: "auto" });
    }
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
        mainColumnEl.scrollBy(0, gridHeightAfter - gridHeightBefore);
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
    applyBatch(sorted.slice(META_NEAR_BATCH)); // fire-and-forget
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

  $: stacks = detectBurstsByGroup(items, groupBy, { gapMs: burstGapMs });
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
        node = await fetchTreeNode({ groupBy: groupByAtCall, path: parent });
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


  async function onKeydown(e) {
    if (e.metaKey || e.ctrlKey) return; // browser shortcuts

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
      });
      const { items: afterPage, focusItem } = await fetchFeed({
        groupBy,
        collapsed: collapsedPaths,
        focusId: targetId,
        before: 0,
        after: PAGE_SIZE,
      });
      if (epoch !== feedEpoch) return;
      // A jump can land anywhere in the library, arbitrarily far from
      // wherever the user was scrolled to before — reset scrollTop to 0
      // *before* items/boxes update, so the reactive updateVisibleRange
      // (which fires as soon as boxes recomputes, before scrollToSection
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
      // The near-selection metadata batch reflows the layout a beat after the
      // jump lands, which can drift the landing photo. Re-pin it to the top
      // once that batch settles (epoch-guarded so a newer jump/load that
      // bumped feedEpoch doesn't yank the view). Runs AFTER the initial
      // scrollToSection + reveal below (metadata is async), so it's the last
      // word, not a racer.
      enrichMeta(items.map((i) => i.id)).then(() => {
        if (epoch === feedEpoch) revealSelected({ align: "top" });
      });
      await tick();
      // Prefer the section header at this index (gives the correct
      // depth-stacked sticky offset), but a group-jump target is only
      // guaranteed to be A photo at the new group's boundary — nothing
      // guarantees displayEntries[selected] is itself the header row (e.g.
      // it can be a stack cover one slot after the header, or the header
      // can have been suppressed by suppressPlaceholderHeaders). Falling
      // back to the target's own box keeps scrollToSection from being
      // skipped in that case, which otherwise leaves mainColumnEl.scrollTop
      // stuck at the 0 this function just forced it to above — and *that*,
      // not the fetch/landing logic, is what was driving the runaway
      // backward-loading cascade: with scrollTop pinned at 0, updateVisibleRange
      // reads the render window as pinned to the start of the loaded feed
      // and keeps calling loadMore("before") once per settled frame,
      // walking back through the entire library page by page (confirmed
      // live: a single jump produced 20+ sequential /api/feed?before=60
      // calls, each stepping focusId back by exactly PAGE_SIZE, until
      // hasMoreBefore ran out near the start of the whole library).
      const targetEntry = displayEntries[selected];
      const targetHeader = layoutResult?.headers.find(
        (h) => h.index === selected
      );
      const targetBox =
        !targetHeader && targetEntry
          ? layoutResult?.boxes.find((b) => b.id === entryDomId(targetEntry))
          : null;
      const scrollTarget =
        targetHeader ?? (targetBox && { y: targetBox.y, depth: 0 });
      if (scrollTarget) await scrollToSection(scrollTarget);
      // scrollToSection only positions the section header — the landing photo
      // itself can still be below the fold. Pin it to the top (instant, so it
      // doesn't animate-fight scrollToSection's just-finished smooth scroll)
      // and give it roving focus, so the jump's selected photo is in view and
      // in focus.
      revealSelected({ align: "top" });
      focusSelectedTile();
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
                  {#if header.path && headerCounts[pathKey(header.path)] !== undefined}
                    <span class="section-count">
                      {headerCounts[pathKey(header.path)].toLocaleString()} items
                    </span>
                  {/if}
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
  .section-count {
    color: #888;
    font-size: 0.85em;
    font-weight: 400;
    /* Matches the collapsed-section placeholder's own count (.placeholder-count)
       so a section reads the same expanded or collapsed. */
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
