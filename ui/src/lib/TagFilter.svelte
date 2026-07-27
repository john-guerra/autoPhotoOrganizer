<script>
  /**
   * Filter by a saved semantic tag (#164) — the other half of the search.
   *
   * A search is disposable; a saved tag is the judgement the user made about
   * where a ranked list stopped being dogs. This is where that judgement gets
   * spent: pick "sunset" and the feed narrows to the photos they kept, and it
   * composes with stars, folders, kinds and the timeline like any other facet.
   *
   * ## Renders NOTHING until a tag exists
   *
   * Not merely to avoid a dead control. This toolbar folds by WIDTH, and two
   * extra buttons in GridControls were once enough to push the whole Group
   * group into an overflow popover at ordinary window sizes — a regression e2e
   * caught and no unit test could (see GridControls.svelte). A library with no
   * saved tags is the default state and by far the common one, so spending
   * width on an empty picker would cost every user for the few who have one.
   *
   * A <select> rather than a row of chips for the same reason: it stays one
   * control wide whether the user has saved one tag or forty.
   *
   * Presentational by contract — App owns the list and the filter state.
   */
  let { filter, tags = [], onchange } = $props();

  let current = $derived(filter?.tag ?? "");

  function pick(value) {
    // "" is the off position, and must clear the key rather than set it to an
    // empty string: filterSpec only treats a non-empty string as active, but
    // leaving `tag: ""` in the spec would still travel in the query param.
    const next = { ...filter };
    if (value) next.tag = value;
    else delete next.tag;
    onchange?.(next);
  }
</script>

{#if tags.length}
  <div class="tagf" role="group" aria-label="Filter by saved tag">
    <span class="legend">Tag</span>
    <select
      value={current}
      onchange={(e) => pick(e.currentTarget.value)}
      aria-label="Filter by saved tag"
      data-testid="tag-filter"
      class:on={!!current}
    >
      <option value="">Any</option>
      {#each tags as t (t.value)}
        <option value={t.value}>
          {t.value} ({t.photos.toLocaleString()})
        </option>
      {/each}
    </select>
  </div>
{/if}

<style>
  .tagf {
    display: inline-flex;
    gap: 2px;
    align-items: center;
    background: #101010;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 2px 4px 2px 2px;
  }
  .legend {
    font-size: 0.7rem;
    color: #8a8a8a;
    padding: 0 4px;
    white-space: nowrap;
  }
  select {
    background: transparent;
    color: #9a9a9a;
    border: none;
    border-radius: 4px;
    padding: 2px 4px;
    min-height: 22px;
    font-size: 0.75rem;
    cursor: pointer;
    max-width: 10rem;
  }
  /* Lit the same blue the other facets use when they are narrowing the view,
     so "why am I only seeing 40 photos" has one visual answer everywhere. */
  select.on {
    background: #4c9aff;
    color: #06121f;
  }
</style>
