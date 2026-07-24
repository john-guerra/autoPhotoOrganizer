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
    notice = "",
    thumbProgress = "",
    thumbCounts = { error: 0 },
    scope,
    jobs,
    selection,
  } = $props();
</script>

<footer class="statusbar">
  <!-- Screen-reader live regions (#a11y). These are ALWAYS in the DOM, empty
       until there's a message: a polite/assertive region that is inserted at the
       same moment as its text is often missed by NVDA/VoiceOver, whereas a
       persistent region reliably announces the change. The visible spans below
       are aria-hidden so the message isn't announced twice. This is what makes
       the app's "never fail silently" invariant reach assistive-tech users, not
       just sighted ones. -->
  <div class="sr-only">
    <span role="status" aria-live="polite">{status}</span>
    <span aria-live="polite">{notice}</span>
    <span role="alert" aria-live="assertive">{error}</span>
  </div>
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
      <span
        class="status"
        class:err={!!error}
        title={error || status}
        aria-hidden="true">{error || status}</span
      >
    {/if}
    <!-- A calm, informational nudge (e.g. the missing-files review prompt): its
         own neutral/blue style so it reads as a heads-up, not a failure. Same
         truncation treatment as .status so a long message can't widen the app. -->
    {#if notice}
      <span class="notice" title={notice} aria-hidden="true">{notice}</span>
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
  /* Visually hidden but present for assistive tech. Not display:none (that would
     stop screen readers announcing it) — clipped to a 1px box off-flow so it
     adds no layout and no flex gap. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .sb-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    /* min-width:0 lets this pane shrink so the flexible .status/.thumb-progress
       inside it can ellipsis instead of widening the app. NOT overflow:hidden —
       that would clip the Export popover, which is an absolutely-positioned child
       lifted up over the feed (see SelectionBar's clampToViewport). The message
       truncation lives on .status itself, so the clip was never needed here. */
    min-width: 0;
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
  /* Neutral, attention-but-calm nudge — a muted blue, clearly distinct from the
     red .err. Truncates exactly like .status (no width regression). */
  .notice {
    color: #7fb2ff;
    font-size: 0.85rem;
    white-space: nowrap;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
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
