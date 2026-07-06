<script>
  // Compact star display. rating 0 renders nothing (or dim dots in `full` mode).
  export let rating = 0;
  export let full = false; // full = show all 5 slots (loupe); else only filled (grid badge)
</script>

{#if full}
  <span class="stars" aria-label={`${rating} of 5 stars`}>
    {#each [1, 2, 3, 4, 5] as n}
      <span class="star" class:on={n <= rating}>★</span>
    {/each}
  </span>
{:else if rating > 0}
  <span class="badge" aria-label={`${rating} stars`}>
    <span class="star on">★</span>{rating}
  </span>
{/if}

<style>
  .stars {
    display: inline-flex;
    gap: 2px;
    font-size: 1.4rem;
    line-height: 1;
  }
  .star {
    color: #4a4a4a;
  }
  .star.on {
    color: #ffc93c;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 1px 5px;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    font-size: 0.72rem;
    font-weight: 600;
  }
  .badge .star {
    font-size: 0.72rem;
  }
</style>
