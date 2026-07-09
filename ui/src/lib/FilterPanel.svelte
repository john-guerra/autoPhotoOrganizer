<script>
  import { createEventDispatcher } from "svelte";
  import { DEFAULT_FILTER, ORIENTATIONS, isActive } from "./filterSpec.js";

  export let filter = { ...DEFAULT_FILTER };
  const dispatch = createEventDispatcher();
  let open = false;

  const RATINGS = [0, 1, 2, 3, 4, 5];
  const ORIENTATION_LABELS = { landscape: "Landscape", portrait: "Portrait", square: "Square" };

  $: active = isActive(filter);

  function emit(next) {
    filter = next;
    dispatch("change", next);
  }
  function setRating(r) {
    emit({ ...filter, minRating: r });
  }
  function toggleOrientation(o) {
    const set = new Set(filter.orientations ?? []);
    set.has(o) ? set.delete(o) : set.add(o);
    emit({ ...filter, orientations: ORIENTATIONS.filter((x) => set.has(x)) });
  }
  function clearAll() {
    emit({ ...DEFAULT_FILTER });
  }
  const has = (o) => (filter.orientations ?? []).includes(o);
</script>

<div class="filter">
  <button class="filter-toggle" class:active on:click={() => (open = !open)} title="Filter photos">
    Filter{#if active}<span class="dot" aria-label="filter active"></span>{/if} ▾
  </button>
  {#if open}
    <div class="filter-panel">
      <div class="row">
        <span class="label">Rating</span>
        <div class="segmented" role="group" aria-label="Minimum rating">
          {#each RATINGS as r}
            <button
              class="seg"
              class:on={(filter.minRating ?? 0) === r}
              on:click={() => setRating(r)}
            >{r === 0 ? "Any" : `≥${r}`}</button>
          {/each}
        </div>
      </div>
      <div class="row">
        <span class="label">Orientation</span>
        <div class="chips">
          {#each ORIENTATIONS as o}
            <button class="chip" class:on={has(o)} on:click={() => toggleOrientation(o)}>
              {ORIENTATION_LABELS[o]}
            </button>
          {/each}
        </div>
      </div>
      <div class="row end">
        <button class="clear" on:click={clearAll} disabled={!active}>Clear</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .filter { position: relative; display: inline-block; }
  .filter-toggle {
    background: #101010; border: 1px solid #333; color: #cfcfcf;
    border-radius: 6px; padding: 4px 10px; font-size: 0.8rem; cursor: pointer;
  }
  .filter-toggle.active { border-color: #4c9aff; color: #fff; }
  .dot {
    display: inline-block; width: 6px; height: 6px; margin: 0 4px;
    background: #4c9aff; border-radius: 50%; vertical-align: middle;
  }
  .filter-panel {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 50;
    background: #0d0d0d; border: 1px solid #333; border-radius: 8px;
    padding: 12px; min-width: 260px; display: flex; flex-direction: column; gap: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  }
  .row { display: flex; flex-direction: column; gap: 6px; }
  .row.end { align-items: flex-end; }
  .label { font-size: 0.72rem; color: #8a8a8a; text-transform: uppercase; letter-spacing: 0.04em; }
  .segmented { display: flex; gap: 2px; background: #101010; border: 1px solid #333; border-radius: 6px; padding: 2px; }
  .seg { flex: 1; border: none; border-radius: 4px; padding: 4px 6px; font-size: 0.78rem; cursor: pointer; background: transparent; color: #9a9a9a; }
  .seg.on { background: #4c9aff; color: #06121f; font-weight: 600; }
  .chips { display: flex; gap: 6px; }
  .chip { border: 1px solid #333; border-radius: 999px; padding: 4px 12px; font-size: 0.78rem; cursor: pointer; background: transparent; color: #9a9a9a; }
  .chip.on { background: #4c9aff; color: #06121f; border-color: #4c9aff; font-weight: 600; }
  .clear { background: transparent; border: 1px solid #444; color: #cfcfcf; border-radius: 6px; padding: 3px 10px; font-size: 0.78rem; cursor: pointer; }
  .clear:disabled { opacity: 0.4; cursor: default; }
</style>
