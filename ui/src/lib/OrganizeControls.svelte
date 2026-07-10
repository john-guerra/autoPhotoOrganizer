<script>
  /**
   * Toolbar cluster ②: grouping (the MultiAutoSelect pill widget), feed sort
   * (attribute + direction), the Display/Select filter-mode toggle, and the
   * rating/orientation filters. Presentational — it renders the current
   * groupBy/sort/filter/filterMode and emits an event for every change; App
   * owns the state and the feed rebuild.
   */
  import { createEventDispatcher } from "svelte";
  import RatingFilter from "./RatingFilter.svelte";
  import OrientationFilter from "./OrientationFilter.svelte";
  import TimelineFilter from "./TimelineFilter.svelte";
  import { DEFAULT_FILTER, isActive as filterIsActive } from "./filterSpec.js";
  import { ALL_DIMENSIONS, SORT_ATTRS, SORT_LABELS } from "./dimensions.js";
  import MultiAutoSelect from "multi-auto-select";

  export let groupBy = ["folder"];
  export let sort = { by: "date_taken", dir: "asc" };
  export let filter = { ...DEFAULT_FILTER };
  export let filterMode = "display";
  // Time-range filter facet (a compact sparkline that sits with stars/orientation).
  export let timeMin = null; // epoch ms domain start (null = no time data yet)
  export let timeMax = null; // epoch ms domain end
  export let timeTimes = []; // sampled timestamps for the density sparkline
  export let currentTime = null; // "you are here" marker (epoch ms)

  const dispatch = createEventDispatcher();

  /** Svelte action: mounts the real MultiAutoSelect DOM widget into the node,
   * seeds it with the current `groupBy`, and emits `groupbychange` when the
   * user reorders/adds/removes a pill. (Seeds once on mount — matches the
   * prior inline behavior; external groupBy changes don't re-sync the widget.) */
  function groupBySelector(node, initialValue) {
    const widget = MultiAutoSelect(ALL_DIMENSIONS, {
      value: initialValue,
      placeholder: "Add a grouping level…",
      sortable: true,
    });
    widget.addEventListener("input", () =>
      dispatch("groupbychange", widget.value)
    );
    node.appendChild(widget);
    return {
      destroy() {
        widget.remove();
      },
    };
  }
</script>

<div class="cluster organize">
  <div class="group-by" use:groupBySelector={groupBy}></div>
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
        dispatch("sortchange", { ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })}
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
      on:click={() => dispatch("filtermodechange", "display")}>Display</button
    >
    <button
      type="button"
      class:active={filterMode === "select"}
      on:click={() => dispatch("filtermodechange", "select")}>Select</button
    >
  </div>
  <div class="divider"></div>
  <RatingFilter {filter} on:change={(e) => dispatch("filterchange", e.detail)} />
  <OrientationFilter {filter} on:change={(e) => dispatch("filterchange", e.detail)} />
  {#if timeMin != null && timeMax != null && timeMax > timeMin}
    <div class="time-filter" title="Filter by capture time — drag the handles">
      <TimelineFilter
        min={timeMin}
        max={timeMax}
        times={timeTimes}
        {currentTime}
        value={[filter.dateFrom ?? null, filter.dateTo ?? null]}
        on:range={(e) =>
          dispatch("filterchange", {
            ...filter,
            dateFrom: e.detail[0],
            dateTo: e.detail[1],
          })}
        on:clear={() =>
          dispatch("filterchange", { ...filter, dateFrom: null, dateTo: null })}
      />
    </div>
  {/if}
  {#if filterIsActive(filter)}
    <button
      class="clear-filter"
      title="Clear filters"
      aria-label="Clear filters"
      on:click={() => dispatch("filterchange", { ...DEFAULT_FILTER })}
    >
      ✕
    </button>
  {/if}
</div>

<style>
  .cluster {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
    flex-shrink: 0;
  }
  .cluster.organize {
    flex-wrap: wrap;
  } /* pills wrap WITHIN the cluster, not pushing siblings */
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
  /* Group boundary between the organize controls (group-by/sort/mode) and the
     filter widgets (stars / orientation / time), matching the toolbar dividers. */
  .divider {
    width: 1px;
    align-self: stretch;
    background: #2a2a2a;
    margin: 2px 0;
  }
  /* Compact home for the timeline sparkline so it sits inline with the other
     filter widgets instead of a full-width strip. Fixed width keeps the toolbar
     stable; the widget measures this box for its axis length + marker. */
  .time-filter {
    width: 260px;
    flex-shrink: 0;
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
  .group-by :global(.multi-auto-select) {
    color: inherit;
  }
  .group-by :global(.pill) {
    background: #2a2a2a !important;
    color: #eee !important;
    border-color: #444 !important;
  }
</style>
