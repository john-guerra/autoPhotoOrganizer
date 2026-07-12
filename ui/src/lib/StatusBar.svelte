<script>
  /**
   * Bottom status bar (#82): read-only ambient state, separated from the
   * top toolbar's actions. Left region = counts + transient status/error +
   * thumb-progress. Right region = grid zoom, burst grouping, and feed sort
   * (sort rightmost). Presentational — App owns the state.
   */
  import { createEventDispatcher } from "svelte";
  import { SORT_ATTRS, SORT_LABELS } from "./dimensions.js";

  export let libraryTotal = 0;
  export let showingCount = 0;
  export let selectedCount = 0;
  export let status = "";
  export let error = "";
  export let thumbProgress = "";
  export let thumbCounts = { error: 0 };
  export let zoom = 2;
  export let zoomMax = 4;
  export let burstEnabled = true;
  export let burstGapMs = 3000;
  export let sort = { by: "date_taken", dir: "asc" };

  const dispatch = createEventDispatcher();
</script>

<footer class="statusbar">
  <div class="sb-left">
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
    {#if error || status}
      <span class="status" class:err={!!error}>{error || status}</span>
    {/if}
    {#if thumbProgress}
      <span class="thumb-progress" class:err={thumbCounts.error > 0}>
        {thumbProgress}
      </span>
    {/if}
  </div>

  <div class="sb-right">
    <label class="zoom" title="Grid zoom (also + / - keys)">
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
        on:change={(e) =>
          dispatch("sortchange", { ...sort, by: e.target.value })}
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
</footer>

<style>
  .statusbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.3rem 1rem;
    background: #1c1c1c;
    border-top: 1px solid #2a2a2a;
    flex-shrink: 0;
  }
  .sb-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }
  .sb-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-left: auto;
    flex-shrink: 0;
  }
  /* Three-level counts: library / showing / selected (lifted from topbar). */
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
  .status {
    color: #9a9a9a;
    font-size: 0.85rem;
    white-space: nowrap;
    flex-shrink: 0;
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
