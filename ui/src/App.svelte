<script>
  import { onMount, tick } from "svelte";
  import { justifiedLayout, layoutHeight } from "./lib/layouts/justified.js";
  import { visibleRange } from "./lib/layouts/windowing.js";
  import { detectBursts } from "./lib/bursts.js";
  import {
    buildDisplayEntries,
    entryDomId,
    resolvePhoto,
  } from "./lib/displayEntries.js";
  import {
    scan as apiScan,
    setRating as apiSetRating,
    setCover as apiSetCover,
    fetchMeta,
    fetchLibrary,
  } from "./lib/api.js";
  import Thumb, { PEEK_STEP_PX, MAX_PEEK_DEPTH } from "./lib/Thumb.svelte";
  import Loupe from "./lib/Loupe.svelte";

  const LS_KEY = "autogallery.lastDir";
  const LS_ZOOM = "autogallery.zoom";
  const LS_BURST_GAP = "autogallery.burstGapMs";
  const DEFAULT_BURST_GAP_MS = 3000;
  const META_CHUNK = 500; // ids per /api/meta request
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

  let dir = localStorage.getItem(LS_KEY) || "";
  let items = [];
  let status = "";
  let error = "";
  let scanning = false;
  let scanEpoch = 0; // invalidates in-flight meta fetches on rescan
  let library = [];
  let libraryOpen = false;

  let selected = 0; // index into displayEntries
  let loupeOpen = false;
  let gridEl;
  let gridWidth = 0;

  // Virtualization: only Thumbs in [renderStart, renderEnd] (plus the
  // selected index) are mounted. Recomputed on scroll/resize/layout change.
  let renderStart = 0;
  let renderEnd = -1;
  let rafPending = false;
  let focusPending = false; // set after a scan; consumed once `boxes` exists
  let expandedStackIds = new Set(); // stack ids currently expanded inline in the grid

  onMount(refreshLibrary);

  async function doScan() {
    if (!dir.trim()) return;
    error = "";
    scanning = true;
    status = "scanning…";
    try {
      const res = await apiScan(dir.trim());
      items = res.items;
      selected = 0;
      loupeOpen = false;
      localStorage.setItem(LS_KEY, res.root);
      refreshLibrary();
      status = `${res.count} photos · scanned in ${res.elapsedMs} ms`;
      enrichMeta(++scanEpoch);
      focusPending = true;
    } catch (e) {
      error = e.message;
      status = "";
      items = [];
    } finally {
      scanning = false;
    }
  }

  async function refreshLibrary() {
    library = await fetchLibrary().catch(() => library);
  }

  function selectFromLibrary(entry) {
    if (!entry.mounted) return;
    dir = entry.path;
    libraryOpen = false;
    doScan();
  }

  async function chooseFolder() {
    const path = await window.autogallery?.pickFolder();
    if (path) {
      dir = path;
      doScan();
    }
  }

  // Progressively fetch dimensions in chunks; the justified layout refines
  // itself as each batch lands (grid appears immediately with placeholders).
  async function enrichMeta(epoch) {
    for (let start = 0; start < items.length; start += META_CHUNK) {
      const ids = items.slice(start, start + META_CHUNK).map((it) => it.id);
      try {
        const metas = await fetchMeta(ids);
        if (epoch !== scanEpoch) return; // a newer scan replaced this session
        for (const m of metas) {
          const it = items[m.id];
          if (it && m.width && m.height) {
            it.width = m.width;
            it.height = m.height;
            it.takenAt = m.takenAt;
          }
        }
        items = items; // re-layout with real aspect ratios
      } catch {
        return; // metadata is an enhancement; the grid still works without it
      }
    }
  }

  // Flickr-style justified layout via the pure module in lib/layouts/ —
  // aspect ratios in, positioned boxes out. Absolutely-positioned children
  // ignore CSS padding, so the frame inset is applied to the box coordinates.
  const PAD = 12;

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
  $: boxes =
    displayEntries.length && gridWidth > 2 * PAD
      ? justifiedLayout(
          displayEntries.map((e) => {
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
          {
            containerWidth: gridWidth - 2 * PAD,
            gap: 8,
            targetRowHeight: rowHeight,
          }
        )
      : null;
  $: gridHeight = boxes ? layoutHeight(boxes) + 2 * PAD : 0;
  $: if (boxes) updateVisibleRange(); // zoom change, meta enrichment, rescan
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

  /** Recompute [renderStart, renderEnd] from the grid's current position. */
  function updateVisibleRange() {
    if (!gridEl || !boxes) {
      renderStart = 0;
      renderEnd = -1;
      return;
    }
    const rect = gridEl.getBoundingClientRect();
    const range = visibleRange(boxes, {
      scrollTop: -rect.top,
      viewportHeight: window.innerHeight,
    });
    renderStart = range.start;
    renderEnd = range.end;
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

  /**
   * Vertical navigation in a justified layout: rows have varying column
   * counts, so move to the box in the adjacent row whose horizontal centre is
   * nearest to the current one.
   * @param {1|-1} dir
   */
  function navVertical(dir) {
    if (!boxes) return selected;
    const cur = boxes[selected];
    if (!cur) return selected;
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
    if (rowY === null) return selected; // already on the first/last row
    // Nearest horizontal centre within that row.
    let best = selected;
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
      if (loupeOpen && selected < displayEntries.length - 1) selected += 1; // auto-advance
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
        if (selected < displayEntries.length - 1) selected += 1;
      } else if (key === "ArrowLeft" || key === "ArrowUp") {
        e.preventDefault();
        if (selected > 0) selected -= 1;
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

    // Grid navigation.
    let next = selected;
    if (key === "ArrowRight")
      next = Math.min(displayEntries.length - 1, selected + 1);
    else if (key === "ArrowLeft") next = Math.max(0, selected - 1);
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
    } else if (key === "Home") next = 0;
    else if (key === "End") next = displayEntries.length - 1;
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

<svelte:window
  on:keydown={onKeydown}
  on:scroll={scheduleVisibleRangeUpdate}
  on:resize={scheduleVisibleRangeUpdate}
/>

<div class="app">
  <header class="topbar">
    <h1>AutoGallery</h1>
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
                disabled={!entry.mounted}
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
  </header>

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
        {#each visibleItems as { i, entry } (entryDomId(entry))}
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
          />
        {/each}
      {/if}
    </div>
  {:else if !scanning}
    <div class="empty">Enter a folder path and press Scan.</div>
  {/if}
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
    min-height: 100vh;
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
  .grid {
    /* Justified layout: children are absolutely positioned by computed boxes;
       height is set inline from the layout result. */
    position: relative;
    width: 100%;
  }
  .grid:focus {
    outline: none;
  }
  .empty {
    padding: 4rem 1rem;
    text-align: center;
    color: #777;
  }
</style>
