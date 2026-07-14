<script>
  /**
   * THE FILTERS, in a box that says so.
   *
   * Everything in here does one thing: it takes photos AWAY. Search, stars,
   * orientation, kind, and the timeline all narrow the same working set, they all
   * compose, and the counts follow all of them. That is worth drawing a border
   * around and giving a name — a toolbar of undifferentiated icons makes you
   * work out for yourself which of them are the reason you can only see 300 of
   * your 114,000 photos.
   *
   * Grouping used to live here and doesn't any more: it doesn't narrow anything,
   * it decides how what's left is carved up (see GroupByControl).
   *
   * The Display/Select toggle stays, because it changes what a filter DOES —
   * narrow the view, or add the matches to the selection.
   *
   * The timeline comes in through a slot rather than as props: it needs a dozen
   * of them (the histogram, the sampled counts, the view/focus markers) and every
   * one is App's state. A slot keeps this component about the filters instead of
   * about plumbing.
   *
   * Presentational — it renders the current filter/filterMode and emits an event
   * for every change; App owns the state and the feed rebuild.
   */
  import { createEventDispatcher } from "svelte";
  import RatingFilter from "./RatingFilter.svelte";
  import SearchFilter from "./SearchFilter.svelte";
  import OrientationFilter from "./OrientationFilter.svelte";
  import KindFilter from "./KindFilter.svelte";
  import { DEFAULT_FILTER, isActive as filterIsActive } from "./filterSpec.js";
  import ToolGroup from "./ToolGroup.svelte";

  export let filter = { ...DEFAULT_FILTER };
  export let filterMode = "display";

  const dispatch = createEventDispatcher();
</script>

<ToolGroup label="Filter" flavor="filters" active={filterIsActive(filter)}>
  <!-- Clearing the filters belongs to the GROUP, not to the row of controls: it
       undoes all of them at once. On the legend it is where you are already
       looking when you ask "why can't I see my photos?" — and it only exists when
       there is something to clear, so it never reads as a dead link. -->
  <svelte:fragment slot="legend-action">
    {#if filterIsActive(filter)}
      <button
        class="clear-link"
        title="Clear every filter"
        on:click={() =>
          dispatch("filterchange", {
            ...DEFAULT_FILTER,
            dateAttr: filter.dateAttr,
          })}
      >
        Clear
      </button>
    {/if}
  </svelte:fragment>

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

  <!-- The timeline: a filter like the rest, and the one that can use the width. -->
  <slot name="timeline" />

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
</ToolGroup>

<style>
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
  /* Quieter than the legend it sits beside: this is an escape hatch, not a call
     to action. No underline, no uppercase, no accent colour until you hover it —
     it only exists at all when a filter is actually hiding something, which is
     the loudest thing about it. */
  .clear-link {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: 0.68rem;
    letter-spacing: normal;
    text-transform: none;
    color: #8a8a8a;
    cursor: pointer;
  }
  .clear-link:hover {
    color: #cfcfcf;
    text-decoration: underline;
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
</style>
