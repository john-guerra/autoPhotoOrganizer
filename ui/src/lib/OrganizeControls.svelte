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
        dispatch("sortchange", {
          ...sort,
          dir: sort.dir === "asc" ? "desc" : "asc",
        })}
    >
      {sort.dir === "asc" ? "↑" : "↓"}
    </button>
  </div>
  <div class="divider"></div>
  <div class="seg-toggle icons" role="group" aria-label="Filter mode">
    <button
      type="button"
      class:active={filterMode === "display"}
      title="Display: the filter narrows what's shown"
      aria-label="Display mode — filter narrows the view"
      aria-pressed={filterMode === "display"}
      on:click={() => dispatch("filtermodechange", "display")}
    >
      <!-- eye: what you see -->
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 3.5C4.4 3.5 1.9 6.6 1.2 8c.7 1.4 3.2 4.5 6.8 4.5s6.1-3.1 6.8-4.5C14.1 6.6 11.6 3.5 8 3.5z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
        />
        <circle cx="8" cy="8" r="2" fill="currentColor" />
      </svg>
    </button>
    <button
      type="button"
      class:active={filterMode === "select"}
      title="Select: matches join the selection instead of narrowing"
      aria-label="Select mode — filter adds matches to the selection"
      aria-pressed={filterMode === "select"}
      on:click={() => dispatch("filtermodechange", "select")}
    >
      <!-- check-square: adds to selection -->
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect
          x="2.2"
          y="2.2"
          width="11.6"
          height="11.6"
          rx="2.4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
        />
        <path
          d="M4.8 8.2l2.1 2.2 4.3-4.6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>
  <RatingFilter
    {filter}
    on:change={(e) => dispatch("filterchange", e.detail)}
  />
  <OrientationFilter
    {filter}
    on:change={(e) => dispatch("filterchange", e.detail)}
  />
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
      on:click={() =>
        dispatch("filterchange", {
          ...DEFAULT_FILTER,
          dateAttr: filter.dateAttr,
        })}
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
  /* Icon variant: square buttons, the SVG inherits the button color (so it turns
     dark-on-blue when active, matching the text variant's contrast). */
  .seg-toggle.icons button {
    padding: 3px 6px;
    display: flex;
    align-items: center;
  }
  .seg-toggle.icons svg {
    width: 15px;
    height: 15px;
    display: block;
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
