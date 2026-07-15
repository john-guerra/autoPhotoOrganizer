<script>
  // Compact star display. rating 0 renders nothing (or dim dots in `full` mode).
  /**
   * @type {{
   *   rating?: number,
   *   full?: boolean,
   *   interactive?: boolean,
   *   onrate?: (value: number) => void,
   * }}
   * `full` shows all 5 slots (loupe) vs only filled (grid badge); `interactive`
   * makes the stars clickable → `onrate(value)`.
   */
  let { rating = 0, full = false, interactive = false, onrate } = $props();

  // Click the current rating again to clear it (toggle to 0), matching the
  // keyboard "0 clears" affordance.
  function set(n) {
    onrate?.(n === rating ? 0 : n);
  }
</script>

{#if interactive}
  <span class="stars" role="radiogroup" aria-label={`Rating: ${rating} of 5`}>
    {#each [1, 2, 3, 4, 5] as n}
      <button
        type="button"
        class="star star-btn"
        class:on={n <= rating}
        aria-label={`${n} star${n === 1 ? "" : "s"}`}
        title={`Set ${n} star${n === 1 ? "" : "s"} (click again to clear)`}
        onclick={(e) => {
          e.stopPropagation();
          set(n);
        }}>★</button
      >
    {/each}
  </span>
{:else if full}
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
  .star-btn {
    background: none;
    border: none;
    padding: 0 1px;
    font: inherit;
    line-height: 1;
    cursor: pointer;
  }
  .star-btn:hover {
    color: #ffe08a;
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
