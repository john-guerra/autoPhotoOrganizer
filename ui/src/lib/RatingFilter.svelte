<script>
  import { applyRatingClick } from "./filterSpec.js";

  let { filter, onchange } = $props();
  let hover = $state(0);
  let min = $derived(filter?.minRating ?? 0);
  const STARS = [1, 2, 3, 4, 5];

  function click(k) {
    onchange?.(applyRatingClick(filter, k));
  }
</script>

<!-- mouseleave (reset hover preview) lives on the group wrapper, which already
     carries role="group" — a static inner <div> with the handler would need a
     role of its own. -->
<div
  class="rating"
  role="group"
  aria-label="Filter by minimum rating"
  onmouseleave={() => (hover = 0)}
>
  <span class="ge" class:active={min > 0} aria-hidden="true">≥</span>
  <div class="stars">
    {#each STARS as k}
      <button
        type="button"
        class="star"
        class:on={(hover || min) >= k}
        class:preview={hover >= k && hover !== min}
        onmouseenter={() => (hover = k)}
        onclick={() => click(k)}
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
