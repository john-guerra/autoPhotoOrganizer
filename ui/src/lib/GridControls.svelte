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
    // #207. Near-duplicate detection is a VIEW control in the same family as
    // the burst gap beside it — how photos are grouped on screen — so it
    // belongs here rather than behind a settings dialog. The two actions are
    // callbacks because they hit the network, and this component is
    // presentational by contract.
    selectedCount = 0,
    dupesRunning = false,
    onfinddupes,
    onburstselection,
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

  <!-- Stacks the SELECTION by time gaps, which manual stacking cannot do: that
       forces every selected photo into one stack regardless of the pauses
       inside it. Hidden rather than disabled with nothing selected — a control
       that can never apply is noise in a toolbar this dense. -->
  {#if selectedCount >= 2}
    <button
      class="grid-action"
      data-testid="burst-selection"
      title={`Stack the ${selectedCount} selected photos into bursts, splitting them wherever the gap exceeds ${(burstGapMs / 1000).toFixed(1)}s`}
      onclick={() => onburstselection?.()}
    >
      Burst selection
    </button>
  {/if}

  <button
    class="grid-action"
    data-testid="find-dupes"
    disabled={dupesRunning}
    title="Find photos of the same shot and stack them, using photo similarity"
    onclick={() => onfinddupes?.()}
  >
    {dupesRunning ? "Finding…" : "Find duplicates"}
  </button>
</div>

<style>
  .grid-action {
    background: #2c2c2c;
    color: inherit;
    border: none;
    border-radius: 4px;
    padding: 0.22rem 0.5rem;
    cursor: pointer;
    font-size: 0.78rem;
    white-space: nowrap;
  }
  .grid-action:hover:not(:disabled) {
    background: #3a3a3a;
  }
  .grid-action:disabled {
    opacity: 0.5;
    cursor: default;
  }
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
