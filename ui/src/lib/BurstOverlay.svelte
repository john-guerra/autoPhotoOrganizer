<script>
  /**
   * The burst/stack overlay glyphs, in ONE place so the feed grid
   * (`Thumb.svelte`) and the loupe filmstrip (`LoupeFilmstrip.svelte`) render a
   * stack identically and can never drift apart:
   *
   *   - a collapsed cover carries the `×N` **badge** (bottom-right, dark pill);
   *   - an expanded member carries the `⚏` **marker** (top-left, blue → gold on
   *     the cover).
   *
   * Only two things legitimately differ between the two call sites, so only two
   * things are parameterised:
   *   - **scale** — the 64px filmstrip cell wants tighter insets / smaller text
   *     than the feed tile. Both are CSS custom properties (`--burst-inset`,
   *     `--burst-font`) that INHERIT from the host element, so a caller sets them
   *     once on the cell and every glyph inside follows. Defaults match the feed.
   *   - **interaction** — pass `oncollapse` to make the marker a real
   *     click/Enter control (the loupe, where Escape closes the loupe instead of
   *     folding the burst). Omit it and the marker is inert, driven by the feed's
   *     keyboard shortcuts (`C` / `Escape`) like before.
   *
   * @type {{
   *   count?: number,               // collapsed cover → render the ×N badge
   *   member?: boolean,             // expanded member → render the ⚏ marker
   *   isCover?: boolean,            // that member is the current cover (gold)
   *   badgeTitle?: string,
   *   markerTitle?: string,
   *   oncollapse?: () => void,      // present → marker is an interactive collapse control
   * }}
   */
  let {
    count,
    member = false,
    isCover = false,
    badgeTitle,
    markerTitle,
    oncollapse,
  } = $props();

  const interactive = $derived(typeof oncollapse === "function");

  function onMarkerClick(e) {
    e.stopPropagation();
    oncollapse();
  }
</script>

{#if count}
  <span class="stack-badge" title={badgeTitle}>×{count}</span>
{/if}
{#if member}
  {#if interactive}
    <!-- A real <button>: native focus + Enter/Space, no role/tabindex hacks. -->
    <button
      type="button"
      class="stack-marker interactive"
      class:is-cover={isCover}
      title={markerTitle}
      onclick={onMarkerClick}>⚏</button
    >
  {:else}
    <span class="stack-marker" class:is-cover={isCover} title={markerTitle}
      >⚏</span
    >
  {/if}
{/if}

<style>
  .stack-badge,
  .stack-marker {
    position: absolute;
    padding: 1px var(--burst-pad-x, 5px);
    font-size: var(--burst-font, 0.7rem);
    line-height: 1;
    border-radius: 3px;
    z-index: 100;
  }
  /* Collapsed cover: ×N, bottom-right on a dark pill. Inert — the click that
     expands a stack lives on the tile/cell, not this badge. */
  .stack-badge {
    right: var(--burst-inset, 5px);
    bottom: var(--burst-inset, 5px);
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  /* Expanded member: ⚏, top-left. Blue by default, gold on the cover.
     Resets (border/font/appearance) keep the interactive <button> variant
     pixel-identical to the plain <span>. */
  .stack-marker {
    left: var(--burst-inset, 5px);
    top: var(--burst-inset, 5px);
    background: rgba(76, 154, 255, 0.75);
    color: #06121f;
    pointer-events: none;
    border: 0;
    font-family: inherit;
    appearance: none;
  }
  .stack-marker.is-cover {
    background: rgba(255, 196, 0, 0.85);
  }
  /* Only the loupe's marker is a control (it collapses the burst); the feed's is
     keyboard-driven and stays inert. */
  .stack-marker.interactive {
    pointer-events: auto;
    cursor: pointer;
    z-index: 101;
  }
</style>
