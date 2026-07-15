<script>
  /**
   * Bottom status bar (#82): read-only ambient state, separated from the top
   * toolbar's ACTIONS. Counts, the selection actions, and the transient
   * status/progress line — nothing here changes how the grid is drawn.
   *
   * Grid zoom, burst and sort used to sit on the right. They are controls, so
   * they moved to the toolbar (GridControls) — which is also what frees this
   * strip's right half for the background-jobs widget.
   */

  let {
    libraryTotal = 0,
    showingCount = 0,
    selectedCount = 0,
    status = "",
    error = "",
    thumbProgress = "",
    thumbCounts = { error: 0 },
    scope,
    jobs,
    selection,
  } = $props();
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
    <!-- The scope ("keep only" / folder) chip belongs beside the SHOWING count,
         not up in the toolbar: it is the reason that number is smaller than the
         library count, and reading the two side by side is what makes the
         narrowed view legible instead of alarming. -->
    {#if scope}{@render scope()}{/if}
    <!-- Selection actions (Clear / Keep only / Export) sit RIGHT NEXT TO the
         selected count — that's what makes "Clear" mean "clear the selection".
         Passed as a snippet so App keeps ownership of the selection + export
         state instead of drilling a dozen props through here. -->
    {#if selection}{@render selection()}{/if}
    <!-- The transient message comes AFTER the actions: "N photos loaded" is a
         separate thought and used to wedge itself between the count and Clear. -->
    {#if error || status}
      <!-- title: the message can be long (a folder path, an error). It truncates
           with an ellipsis rather than widening the whole app, so the full text
           lives in the tooltip. -->
      <span class="status" class:err={!!error} title={error || status}
        >{error || status}</span
      >
    {/if}
    {#if thumbProgress}
      <span class="thumb-progress" class:err={thumbCounts.error > 0}>
        {thumbProgress}
      </span>
    {/if}
  </div>

  <!-- Background jobs live down here, in the corner furthest from the photos. -->
  <div class="sb-right">
    {#if jobs}{@render jobs()}{/if}
  </div>
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
    /* The counts/scope/actions keep their size; the transient message is what
       must give when the row runs out of room (see .status). Without this the
       message pushed the whole app wider than the window. */
    overflow: hidden;
  }
  /* Pushed to the far corner, and allowed to keep its width: the jobs pill is
     small and elides its own text, so the left half is what should give. */
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
    /* Shrink and ellipsis instead of forcing the status bar (and the app) wider.
       The full text is in the title tooltip. */
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status.err {
    color: #ff6b6b;
  }
  .thumb-progress {
    color: #9a9a9a;
    font-size: 0.8rem;
    white-space: nowrap;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .thumb-progress.err {
    color: #ff8a80;
  }
</style>
