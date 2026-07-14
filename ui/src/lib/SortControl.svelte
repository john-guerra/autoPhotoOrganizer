<script>
  /**
   * In what ORDER the photos come. Useful, but not a headline — so it is drawn
   * like the grouping pills next door: a small muted caption over a borderless
   * control, rather than another boxed widget competing with the buttons beside
   * it. It sits at the far right of the View group, the last question you ask.
   */
  import { createEventDispatcher } from "svelte";
  import { SORT_ATTRS, SORT_LABELS } from "./dimensions.js";

  export let sort = { by: "date_taken", dir: "asc" };

  const dispatch = createEventDispatcher();
</script>

<div class="sort-control" title="Sort photos">
  <span class="title">Sort</span>
  <div class="row">
    <select
      class="sort-by"
      aria-label="Sort by"
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
  .sort-control {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
  /* Deliberately the same caption as MultiAutoSelect's compact "Group by" title —
     same size, same colour, same 1px of breathing room — so the two controls read
     as siblings instead of as two unrelated widgets that happen to be adjacent. */
  .title {
    font-size: 0.7rem;
    color: #9a9a9a;
    margin-bottom: 1px;
    line-height: 1;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .sort-by {
    background: transparent;
    border: none;
    color: #cfcfcf;
    font-size: 0.8rem;
    padding: 2px 2px;
    cursor: pointer;
  }
  .sort-dir {
    border: none;
    border-radius: 4px;
    background: transparent;
    color: #9a9a9a;
    font-size: 0.9rem;
    line-height: 1;
    padding: 2px 5px;
    cursor: pointer;
  }
  .sort-dir:hover {
    background: #222;
    color: #e8e8e8;
  }
</style>
