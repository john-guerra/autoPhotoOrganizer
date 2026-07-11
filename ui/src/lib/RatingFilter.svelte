<script>
  import { createEventDispatcher } from "svelte";
  import { applyRatingClick } from "./filterSpec.js";

  export let filter;
  const dispatch = createEventDispatcher();
  let hover = 0;
  $: min = filter?.minRating ?? 0;
  const STARS = [1, 2, 3, 4, 5];

  function click(k) {
    dispatch("change", applyRatingClick(filter, k));
  }
</script>

<div class="rating" role="group" aria-label="Filter by minimum rating">
  <span class="ge" class:active={min > 0} aria-hidden="true">≥</span>
  <div class="stars" on:mouseleave={() => (hover = 0)}>
    {#each STARS as k}
      <button
        type="button"
        class="star"
        class:on={(hover || min) >= k}
        class:preview={hover >= k && hover !== min}
        on:mouseenter={() => (hover = k)}
        on:click={() => click(k)}
        aria-label={`filter: ${k} star${k > 1 ? "s" : ""} or more`}
        aria-pressed={min >= k}>★</button
      >
    {/each}
  </div>
</div>

<style>
  .rating {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .ge {
    font-size: 0.85rem;
    color: #6a6a6a;
    font-weight: 600;
  }
  .ge.active {
    color: #ffc93c;
  }
  .stars {
    display: inline-flex;
    gap: 1px;
  }
  .star {
    background: none;
    border: none;
    padding: 0 1px;
    cursor: pointer;
    font-size: 1.15rem;
    line-height: 1;
    color: #4a4a4a;
    transition: color 0.08s;
  }
  .star.on {
    color: #ffc93c;
  }
  .star.preview {
    color: #7a6a2c;
  }
</style>
