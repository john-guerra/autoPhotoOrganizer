<script>
  /**
   * Which navigator the sidebar shows: the folder Tree, or the Fisheye.
   *
   * Extracted from ViewControls so it can sit on its own toolbar row, above the
   * sidebar it controls — a control belongs over the thing it changes, and in the
   * middle of the View cluster it read as just another view button.
   *
   * It was written with inline `style=` attributes and no class hooks, which is
   * why it could not be styled or moved. Same seg-toggle language as the rest of
   * the toolbar now.
   */
  export let sidebarMode = "tree";

  const MODES = [
    { id: "tree", label: "Tree" },
    { id: "fisheye", label: "Fisheye" },
  ];
</script>

<div class="seg-toggle" role="group" aria-label="Sidebar view">
  {#each MODES as mode}
    <button
      type="button"
      class:active={sidebarMode === mode.id}
      aria-pressed={sidebarMode === mode.id}
      on:click={() => (sidebarMode = mode.id)}
    >
      {mode.label}
    </button>
  {/each}
</div>

<style>
  .seg-toggle {
    display: flex;
    gap: 2px;
    background: #101010;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 2px;
    flex-shrink: 0;
  }
  .seg-toggle button {
    border: none;
    border-radius: 4px;
    padding: 3px 9px;
    font-size: 0.8rem;
    cursor: pointer;
    background: transparent;
    color: #9a9a9a;
  }
  .seg-toggle button.active {
    background: #4c9aff;
    color: #06121f;
    font-weight: 600;
  }
</style>
