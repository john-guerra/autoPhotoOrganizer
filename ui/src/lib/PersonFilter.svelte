<script>
  /**
   * Filter the library to one person (#167).
   *
   * Renders NOTHING until someone has been found — the same rule TagFilter
   * follows, and for the same measured reason: this toolbar folds by WIDTH,
   * and two extra controls in GridControls once pushed the whole Group group
   * into an overflow popover at ordinary window sizes. A library with no
   * people is the default state and by far the common one.
   *
   * A <select> rather than a row of faces, so it stays one control wide
   * whether the user has three people or three hundred.
   */
  let { filter, people = [], onchange } = $props();

  let current = $derived(filter?.personId ?? "");

  function pick(value) {
    const next = { ...filter };
    const id = Number(value);
    // "" is the off position and must DELETE the key: filterSpec only treats
    // a positive integer as active, but leaving personId: "" in the spec
    // would still travel in the query param.
    if (Number.isSafeInteger(id) && id > 0) next.personId = id;
    else delete next.personId;
    onchange?.(next);
  }

  /** An unnamed person is still browsable — #167 is explicit about it — so
   *  they get a stable label rather than being hidden until named. */
  const label = (p) =>
    `${p.name || `Unnamed (${p.faces} face${p.faces === 1 ? "" : "s"})`} · ${p.photos}`;
</script>

{#if people.length}
  <div class="pf" role="group" aria-label="Filter by person">
    <span class="legend">Person</span>
    <select
      value={current}
      onchange={(e) => pick(e.currentTarget.value)}
      aria-label="Filter by person"
      data-testid="person-filter"
      class:on={!!current}
    >
      <option value="">Anyone</option>
      {#each people as p (p.id)}
        <option value={p.id}>{label(p)}</option>
      {/each}
    </select>
  </div>
{/if}

<style>
  .pf {
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
    max-width: 11rem;
  }
  /* The same blue every other facet uses when it is narrowing the view, so
     "why am I only seeing 40 photos" has one visual answer everywhere. */
  select.on {
    background: #4c9aff;
    color: #06121f;
  }
</style>
