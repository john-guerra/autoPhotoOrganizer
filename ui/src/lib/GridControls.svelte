<script>
  /**
   * How the grid is DRAWN: thumbnail size, burst grouping, sort order.
   *
   * These lived in the status bar's right half, which was the wrong home twice
   * over. They are controls, not ambient state — the status bar is the read-only
   * strip (counts, transient status, progress) — and they were occupying the one
   * piece of chrome with nothing else in it, which is where the background-jobs
   * widget needs to live. Moving them up frees the bottom-right and puts every
   * control in the toolbar.
   *
   * Presentational: App owns the state, these are two-way bound.
   */
  import { createEventDispatcher } from "svelte";
  import { SORT_ATTRS, SORT_LABELS } from "./dimensions.js";

  export let zoom = 2;
  export let zoomMax = 4;
  export let burstEnabled = true;
  export let burstGapMs = 3000;
  export let sort = { by: "date_taken", dir: "asc" };

  const dispatch = createEventDispatcher();
</script>

<div class="grid-controls">
  <label class="zoom" title="Thumbnail size (also + / - keys)">
    <span class="zoom-icon small">▦</span>
    <input type="range" min="0" max={zoomMax} step="1" bind:value={zoom} />
    <span class="zoom-icon">▦</span>
  </label>

  <label class="burst" title="Group photos taken close in time as a burst">
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

  <div class="sort-control" title="Sort photos">
    <select
      class="sort-by"
      value={sort.by}
      on:change={(e) => dispatch("sortchange", { ...sort, by: e.target.value })}
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
        dispatch("sortchange", {
          ...sort,
          dir: sort.dir === "asc" ? "desc" : "asc",
        })}
    >
      {sort.dir === "asc" ? "↑" : "↓"}
    </button>
  </div>
</div>

<style>
  .grid-controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
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
</style>
