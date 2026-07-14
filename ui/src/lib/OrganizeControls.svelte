<script>
  /**
   * Toolbar cluster ②: grouping (the MultiAutoSelect pill widget), the
   * Display/Select filter-mode toggle, and the rating/orientation filters.
   * Presentational — it renders the current groupBy/filter/filterMode and
   * emits an event for every change; App owns the state and the feed
   * rebuild.
   */
  import { createEventDispatcher } from "svelte";
  import RatingFilter from "./RatingFilter.svelte";
  import SearchFilter from "./SearchFilter.svelte";
  import OrientationFilter from "./OrientationFilter.svelte";
  import KindFilter from "./KindFilter.svelte";
  import { DEFAULT_FILTER, isActive as filterIsActive } from "./filterSpec.js";
  import { ALL_DIMENSIONS } from "./dimensions.js";
  import MultiAutoSelect from "multi-auto-select";

  export let groupBy = ["folder"];
  export let filter = { ...DEFAULT_FILTER };
  export let filterMode = "display";

  const dispatch = createEventDispatcher();

  /** Svelte action: mounts the real MultiAutoSelect DOM widget into the node,
   * seeds it with the current `groupBy`, and emits `groupbychange` when the
   * user reorders/adds/removes a pill. (Seeds once on mount — matches the
   * prior inline behavior; external groupBy changes don't re-sync the widget.) */
  function groupBySelector(node, initialValue) {
    const widget = MultiAutoSelect(ALL_DIMENSIONS, {
      value: initialValue,
      title: "Group by",
      placeholder: "Add…",
      sortable: true,
      layout: "compact",
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
  <SearchFilter
    {filter}
    on:change={(e) => dispatch("filterchange", e.detail)}
  />
  <RatingFilter
    {filter}
    on:change={(e) => dispatch("filterchange", e.detail)}
  />
  <OrientationFilter
    {filter}
    on:change={(e) => dispatch("filterchange", e.detail)}
  />
  <KindFilter {filter} on:change={(e) => dispatch("filterchange", e.detail)} />
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
  /* THE SHRINK ORDER. This cluster used to be `flex-wrap: wrap`, and every child
     was unshrinkable — so when the toolbar ran out of room the group-by pills
     dropped onto a second line, and the whole bar reflowed as you added a
     grouping dimension. Nothing wraps now: the cluster itself shrinks, and inside
     it the one thing that CAN lose width without losing meaning does so — the search
     box (you can still read the tail of what you typed). The group-by pills keep
     their width (they are what the toolbar is about), and the filter icons are
     already as small as they get.

     The timeline used to live here and was the widest thing in the row; it moved
     to the toolbar's SECOND row, where it gets more width than it ever had. */
  .cluster.organize {
    flex-wrap: nowrap;
    flex-shrink: 1;
    min-width: 0;
  }
  /* NOTHING in this cluster shrinks by default. flex items are flex-shrink:1 out
     of the box, so once the cluster itself became shrinkable, every child started
     giving up width at once: the group-by widget wrapped its own pills onto a
     second and third line, and the Type filter had its last button sliced off by
     the neighbour beside it. Both are the same reflow this change exists to kill,
     just relocated.
     Exactly ONE child is allowed to give, below. */
  .cluster.organize > :global(*) {
    flex-shrink: 0;
  }
  /* The search box. It is the only control here that loses width without losing
     meaning — the text scrolls, and you can still read the tail of what you
     typed. Everything else is icons and pills, which just get clipped. */
  .cluster.organize > :global(.search) {
    flex-shrink: 1;
    min-width: 0;
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
  /* Group boundary between the organize controls (group-by/mode) and the
     filter widgets (stars / orientation / time), matching the toolbar dividers. */
  .divider {
    width: 1px;
    align-self: stretch;
    background: #2a2a2a;
    margin: 2px 0;
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
  /* Compact layout: keep the "Group by" title small and the whole widget
     vertically tight so it fits the toolbar row. */
  .group-by :global(.multi-auto-select.compact .title) {
    font-size: 0.7rem;
    color: #9a9a9a;
    margin-bottom: 1px;
  }
  .group-by :global(.multi-auto-select.compact) {
    min-height: 0 !important;
  }
  .group-by :global(.pill) {
    background: #2a2a2a !important;
    color: #eee !important;
    border-color: #444 !important;
  }
</style>
