<script>
  // The shared actions cluster for a group/album label (issue #88). Rendered
  // identically in all three feed-header states (expanded section header,
  // snapshot strip head, collapsed pill) so a group offers the SAME actions
  // regardless of its display state — instead of three drifting inline copies.
  //
  // Purely presentational: it dispatches intent and lets App.svelte run the
  // canonical handlers (toggleGroupSelectAll / keepOnlyGroup / removeAlbum).
  // Every button stops click propagation so it never triggers the surrounding
  // row's own click (e.g. the collapsed pill's cycle). The tri-state checkbox
  // is the select-all affordance — there is no separate "Select" button (it
  // would only duplicate the checkbox's select half).
  let {
    /** @type {"none"|"some"|"all"|"loading"} tri-state select indicator */
    selectState = "none",
    /** show the Remove action — true for any group that can be removed from the
     *  library (a folder subtree, or a non-folder group removed by its photos) */
    canRemove = false,
    /** Remove is armed (first click) → show "Confirm remove" in danger style */
    removeArmed = false,
    ontoggleselect,
    onjumpprev,
    onjumpnext,
    onkeeponly,
    onremove,
  } = $props();

  // The subtree, not just this folder: clicking a parent takes what's under it.
  // Shift is called out because a partially-selected group is exactly when you
  // can't tell what a plain click will do, and it's the state you most often want
  // to empty.
  let selectTitle = $derived(
    selectState === "all"
      ? "Deselect every photo in this group"
      : selectState === "some"
        ? "Select every photo in this group (and the folders under it) — Shift-click to deselect them all"
        : "Select every photo in this group, and the folders under it"
  );
</script>

<span class="gla">
  <!-- Always visible: a status indicator, not just an action. -->
  <button
    class="gla-select {selectState}"
    title={selectTitle}
    aria-label={selectTitle}
    aria-pressed={selectState === "all"}
    onclick={(e) => {
      e.stopPropagation();
      ontoggleselect?.(e);
    }}
  >
    {#if selectState === "all"}✓{:else if selectState === "some"}–{:else if selectState === "loading"}⋯{/if}
  </button>

  <!-- Revealed on header hover (App.svelte controls opacity across the boundary). -->
  <span class="gla-buttons">
    <!-- The UI equivalent of the Option+←/→ group-jump shortcut, anchored on
         THIS group rather than wherever the keyboard focus happens to be. -->
    <button
      class="section-act nav"
      title="Jump to the previous group (Option+←)"
      aria-label="Jump to the previous group"
      onclick={(e) => {
        e.stopPropagation();
        onjumpprev?.();
      }}
    >
      ‹
    </button>
    <button
      class="section-act nav"
      title="Jump to the next group (Option+→)"
      aria-label="Jump to the next group"
      onclick={(e) => {
        e.stopPropagation();
        onjumpnext?.();
      }}
    >
      ›
    </button>
    <button
      class="section-act"
      title="Keep only this group as the working set"
      onclick={(e) => {
        e.stopPropagation();
        onkeeponly?.();
      }}
    >
      Keep only
    </button>
    {#if canRemove}
      <button
        class="section-act"
        class:danger={removeArmed}
        title={removeArmed
          ? "Click again to remove every photo in this group from the library"
          : "Remove every photo in this group from the library (files on disk are untouched; ratings are lost)"}
        onclick={(e) => {
          e.stopPropagation();
          onremove?.();
        }}
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
  /* The ‹/› group-jump pair: square and glyph-only, so they read as navigation
     rather than another word-button. */
  .section-act.nav {
    padding: 1px 6px;
    font-size: 0.85rem;
    line-height: 1.1;
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
