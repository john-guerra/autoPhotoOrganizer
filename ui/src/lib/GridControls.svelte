<script>
  /**
   * How BIG the photos are drawn: thumbnail size, and whether a run of shots
   * taken seconds apart is stacked into one burst.
   *
   * These lived in the status bar, which was the wrong home twice over. They are
   * controls, not ambient state — the status bar is the read-only strip (counts,
   * transient status, progress) — and they were occupying the one piece of chrome
   * with nothing else in it, which is where the background-jobs widget needed to
   * live.
   *
   * Sort left too, into its own group hard right (SortControl): order is a
   * different question from size, and the toolbar now says which is which.
   *
   * Presentational: App owns the state, these are two-way bound.
   */
  let {
    zoom = $bindable(2),
    zoomMax = 4,
    burstEnabled = $bindable(true),
    burstGapMs = $bindable(3000),
  } = $props();
</script>

<div class="grid-controls">
  <label class="zoom" title="Thumbnail size (also + / - keys)">
    <span class="zoom-icon small">▦</span>
    <input type="range" min="0" max={zoomMax} step="1" bind:value={zoom} />
    <span class="zoom-icon">▦</span>
  </label>

  <label class="burst" title="Group photos taken close in time as a burst">
    <input type="checkbox" bind:checked={burstEnabled} />
    <span class="burst-label">Burst</span>
    <input
      type="range"
      min="0"
      max="10000"
      step="500"
      bind:value={burstGapMs}
      disabled={!burstEnabled}
    />
    <span class="burst-value" class:off={!burstEnabled}
      >{(burstGapMs / 1000).toFixed(1)}s</span
    >
  </label>
</div>

<style>
  .grid-controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
  }
  .zoom {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #777;
  }
  .zoom input[type="range"] {
    width: 90px;
    accent-color: #4c9aff;
  }
  .zoom-icon {
    font-size: 1rem;
    line-height: 1;
  }
  .zoom-icon.small {
    font-size: 0.7rem;
  }
  .burst {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 0.78rem;
    color: #9a9a9a;
  }
  .burst input[type="range"] {
    width: 90px;
    accent-color: #4c9aff;
  }
  .burst input[type="range"]:disabled {
    opacity: 0.4;
  }
  .burst-value.off {
    opacity: 0.4;
  }
</style>
