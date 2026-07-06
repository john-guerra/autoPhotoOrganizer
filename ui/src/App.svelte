<script>
  import { tick } from "svelte";
  import { scan as apiScan, setRating as apiSetRating } from "./lib/api.js";
  import Thumb from "./lib/Thumb.svelte";
  import Loupe from "./lib/Loupe.svelte";

  const LS_KEY = "autogallery.lastDir";

  let dir = localStorage.getItem(LS_KEY) || "";
  let items = [];
  let status = "";
  let error = "";
  let scanning = false;

  let selected = 0; // index into items
  let loupeOpen = false;
  let gridEl;

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
    } catch (e) {
      error = e.message;
      status = "";
      items = [];
    } finally {
      scanning = false;
    }
  }

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

  /** Number of columns currently rendered, read from the CSS grid. */
  function columns() {
    if (!gridEl) return 1;
    const cols = getComputedStyle(gridEl).gridTemplateColumns.split(" ").length;
    return Math.max(1, cols);
  }

  function onKeydown(e) {
    if (!items.length) return;
    const key = e.key;

    // Star rating 0–5 works in both grid and loupe.
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
    const cols = columns();
    let next = selected;
    if (key === "ArrowRight") next = Math.min(items.length - 1, selected + 1);
    else if (key === "ArrowLeft") next = Math.max(0, selected - 1);
    else if (key === "ArrowDown")
      next = Math.min(items.length - 1, selected + cols);
    else if (key === "ArrowUp") next = Math.max(0, selected - cols);
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
    <span class="status" class:err={!!error}>{error || status}</span>
  </header>

  {#if items.length}
    <div class="grid" bind:this={gridEl} role="listbox" tabindex="-1">
      {#each items as item, i (item.id)}
        <Thumb
          {item}
          selected={i === selected}
          on:click={() => openLoupe(i)}
        />
      {/each}
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
  .status {
    color: #9a9a9a;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .status.err {
    color: #ff6b6b;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 8px;
    padding: 12px;
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
