<script>
  import { tick } from "svelte";
  import { justifiedLayout, layoutHeight } from "./lib/layouts/justified.js";
  import {
    scan as apiScan,
    setRating as apiSetRating,
    fetchMeta,
  } from "./lib/api.js";
  import Thumb from "./lib/Thumb.svelte";
  import Loupe from "./lib/Loupe.svelte";

  const LS_KEY = "autogallery.lastDir";
  const LS_ZOOM = "autogallery.zoom";
  const META_CHUNK = 500; // ids per /api/meta request
  const DEFAULT_RATIO = 1.5; // placeholder until real dimensions arrive

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

  let selected = 0; // index into items
  let loupeOpen = false;
  let gridEl;
  let gridWidth = 0;

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
      status = `${res.count} photos · scanned in ${res.elapsedMs} ms`;
      enrichMeta(++scanEpoch);
    } catch (e) {
      error = e.message;
      status = "";
      items = [];
    } finally {
      scanning = false;
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
  $: boxes =
    items.length && gridWidth > 2 * PAD
      ? justifiedLayout(
          items.map((it) => ({
            id: it.id,
            aspectRatio:
              it.width && it.height ? it.width / it.height : DEFAULT_RATIO,
          })),
          {
            containerWidth: gridWidth - 2 * PAD,
            gap: 8,
            targetRowHeight: rowHeight,
          }
        )
      : null;
  $: gridHeight = boxes ? layoutHeight(boxes) + 2 * PAD : 0;

  function rate(index, rating) {
    const it = items[index];
    if (!it) return;
    it.rating = rating;
    items = items; // trigger reactivity
    apiSetRating(it.id, rating).catch((e) => (error = e.message));
  }

  function openLoupe(index) {
    selected = index;
    loupeOpen = true;
  }

  async function closeLoupe() {
    loupeOpen = false;
    await tick();
    // Return focus to the grid, scrolled to the current item.
    gridEl?.querySelector(`[data-id="${items[selected]?.id}"]`)?.focus();
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

  function onKeydown(e) {
    // Never steal keystrokes from a focused input (e.g. typing a folder path
    // with digits in it must not rate photos).
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable)
      return;
    if (e.metaKey || e.ctrlKey || e.altKey) return; // browser shortcuts

    if (!items.length) return;
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
      if (loupeOpen && selected < items.length - 1) selected += 1; // auto-advance
      return;
    }

    if (loupeOpen) {
      if (key === "Escape") {
        e.preventDefault();
        closeLoupe();
      } else if (key === "ArrowRight" || key === "ArrowDown") {
        e.preventDefault();
        if (selected < items.length - 1) selected += 1;
      } else if (key === "ArrowLeft" || key === "ArrowUp") {
        e.preventDefault();
        if (selected > 0) selected -= 1;
      }
      return;
    }

    // Grid navigation.
    let next = selected;
    if (key === "ArrowRight") next = Math.min(items.length - 1, selected + 1);
    else if (key === "ArrowLeft") next = Math.max(0, selected - 1);
    else if (key === "ArrowDown") next = navVertical(1);
    else if (key === "ArrowUp") next = navVertical(-1);
    else if (key === "Enter" || key === " ") {
      e.preventDefault();
      openLoupe(selected);
      return;
    } else if (key === "Home") next = 0;
    else if (key === "End") next = items.length - 1;
    else return;

    e.preventDefault();
    selected = next;
    gridEl?.querySelector(`[data-id="${items[selected]?.id}"]`)?.focus();
  }
</script>

<svelte:window on:keydown={onKeydown} />

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
        {#each items as item, i (item.id)}
          <Thumb
            {item}
            box={boxes[i]}
            pad={PAD}
            size={thumbSize}
            selected={i === selected}
            on:click={() => openLoupe(i)}
          />
        {/each}
      {/if}
    </div>
  {:else if !scanning}
    <div class="empty">Enter a folder path and press Scan.</div>
  {/if}
</div>

{#if loupeOpen}
  <Loupe {items} bind:index={selected} />
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
    z-index: 10;
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
