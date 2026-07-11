<script>
  // The shared actions cluster for a group/album label (issue #88). Rendered
  // identically in all three feed-header states (expanded section header,
  // snapshot strip head, collapsed pill) so a group offers the SAME actions
  // regardless of its display state — instead of three drifting inline copies.
  //
  // Purely presentational: it dispatches intent and lets App.svelte run the
  // canonical handlers (selectGroup / keepOnlyGroup / removeAlbum /
  // toggleGroupSelectAll). Every button stops click propagation so it never
  // triggers the surrounding row's own click (e.g. the collapsed pill's cycle).
  import { createEventDispatcher } from "svelte";

  /** @type {"none"|"some"|"all"|"loading"} tri-state select indicator */
  export let selectState = "none";
  /** show the Remove action (only meaningful for a folder leaf group) */
  export let isFolder = false;
  /** Remove is armed (first click) → show "Confirm remove" in danger style */
  export let removeArmed = false;

  const dispatch = createEventDispatcher();

  $: selectTitle =
    selectState === "all"
      ? "Deselect every photo in this group"
      : "Select every photo in this group";
</script>

<span class="gla">
  <!-- Always visible: a status indicator, not just an action. -->
  <button
    class="gla-select {selectState}"
    title={selectTitle}
    aria-label={selectTitle}
    aria-pressed={selectState === "all"}
    on:click|stopPropagation={() => dispatch("toggleselect")}
  >
    {#if selectState === "all"}✓{:else if selectState === "some"}–{:else if selectState === "loading"}⋯{/if}
  </button>

  <!-- Revealed on header hover (App.svelte controls opacity across the boundary). -->
  <span class="gla-buttons">
    <button
      class="section-act"
      title="Select every photo in this group"
      on:click|stopPropagation={() => dispatch("select")}
    >
      Select
    </button>
    <button
      class="section-act"
      title="Keep only this group as the working set"
      on:click|stopPropagation={() => dispatch("keeponly")}
    >
      Keep only
    </button>
    {#if isFolder}
      <button
        class="section-act"
        class:danger={removeArmed}
        title="Remove this album from the library (files on disk are untouched; ratings are lost)"
        on:click|stopPropagation={() => dispatch("remove")}
      >
        {removeArmed ? "Confirm remove" : "Remove"}
      </button>
    {/if}
  </span>
</span>

<style>
  .gla {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 8px;
  }
  /* The select icon: a small tri-state checkbox harmonised with the gold
     per-photo selection indicator (#ffd24c). Always visible. */
  .gla-select {
    flex: 0 0 auto;
    width: 17px;
    height: 17px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid #888;
    border-radius: 3px;
    background: transparent;
    color: transparent;
    font-size: 0.72rem;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
  }
  .gla-select:hover {
    border-color: #ffd24c;
  }
  .gla-select.some {
    border-color: #ffd24c;
    background: rgba(255, 210, 76, 0.14);
    color: #ffd24c;
  }
  .gla-select.all {
    border-color: #ffd24c;
    background: #ffd24c;
    color: #1a1400;
  }
  .gla-select.loading {
    border-color: #555;
    color: #777;
  }

  /* Action buttons default hidden; App reveals them on header hover via a
     :global rule (the reveal target crosses the component boundary). */
  .gla-buttons {
    display: inline-flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.1s ease;
  }
  .section-act {
    background: #222;
    border: 1px solid #3a3a3a;
    color: #cfcfcf;
    border-radius: 4px;
    padding: 1px 7px;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .section-act:hover {
    background: #2f2f2f;
    color: #fff;
  }
  .section-act.danger {
    background: #5a1a1a;
    border-color: #a33;
    color: #ffd7d7;
  }
  .section-act.danger:hover {
    background: #7a2020;
  }
</style>
