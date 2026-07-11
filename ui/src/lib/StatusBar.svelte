<script>
  /**
   * Bottom status bar (#82): read-only ambient state, separated from the
   * top toolbar's actions. Left region = counts + transient status/error +
   * thumb-progress. Right region (zoom / burst / sort) is added in the next
   * step of the reorg. Presentational — App owns the state.
   */
  export let libraryTotal = 0;
  export let showingCount = 0;
  export let selectedCount = 0;
  export let status = "";
  export let error = "";
  export let thumbProgress = "";
  export let thumbCounts = { error: 0 };
</script>

<footer class="statusbar">
  <div class="sb-left">
    <div
      class="counts"
      title="Photos in the whole library · shown under the current filter/focus · currently selected"
    >
      <span>{libraryTotal.toLocaleString()} <em>library</em></span>
      <span>{showingCount.toLocaleString()} <em>showing</em></span>
      <span class:has-sel={selectedCount > 0}
        >{selectedCount.toLocaleString()} <em>selected</em></span
      >
    </div>
    {#if error || status}
      <span class="status" class:err={!!error}>{error || status}</span>
    {/if}
    {#if thumbProgress}
      <span class="thumb-progress" class:err={thumbCounts.error > 0}>
        {thumbProgress}
      </span>
    {/if}
  </div>

  <div class="sb-right"></div>
</footer>

<style>
  .statusbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.3rem 1rem;
    background: #1c1c1c;
    border-top: 1px solid #2a2a2a;
    flex-shrink: 0;
  }
  .sb-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }
  .sb-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-left: auto;
    flex-shrink: 0;
  }
  /* Three-level counts: library / showing / selected (lifted from topbar). */
  .counts {
    display: flex;
    gap: 10px;
    font-size: 0.8rem;
    color: #cfcfcf;
    white-space: nowrap;
  }
  .counts em {
    font-style: normal;
    color: #808080;
  }
  .counts .has-sel {
    color: #ffd24c;
    font-weight: 600;
  }
  .counts .has-sel em {
    color: #b9932f;
  }
  .status {
    color: #9a9a9a;
    font-size: 0.85rem;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .status.err {
    color: #ff6b6b;
  }
  .thumb-progress {
    color: #9a9a9a;
    font-size: 0.8rem;
    white-space: nowrap;
  }
  .thumb-progress.err {
    color: #ff8a80;
  }
</style>
