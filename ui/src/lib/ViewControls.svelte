<script>
  /**
   * Toolbar cluster ③: "Locate current", the global cycle-all-groups control,
   * and the Albums toggle. Presentational — every action is emitted as an event.
   *
   * The Tree/Fisheye toggle used to live here. It moved to SidebarModeToggle, on
   * its own toolbar row directly above the sidebar it controls: in the middle of
   * this cluster it read as just another view button, rather than as the switch
   * for the whole left column.
   */
  import { createEventDispatcher } from "svelte";

  export let cyclingAll = false;
  export let globalViewMode = "full";
  export let albumMode = false;
  export let detectingAlbums = false;

  const dispatch = createEventDispatcher();
</script>

<div class="cluster view">
  <button
    class="reveal-btn"
    on:click={() => dispatch("revealcurrent")}
    title="Reveal the current photo's location in the tree"
  >
    ⌖ Locate
  </button>
  <button
    class="reveal-btn"
    on:click={() => dispatch("cycleall")}
    disabled={cyclingAll}
    title="Cycle every group: full view → snapshot all → collapse all"
  >
    {cyclingAll
      ? "…"
      : globalViewMode === "snapshot"
        ? "◐ Snapshot all"
        : globalViewMode === "collapsed"
          ? "▸ Collapsed all"
          : "▦ Full view"}
  </button>
  <button
    class="reveal-btn"
    class:active={albumMode}
    on:click={() =>
      albumMode ? (albumMode = false) : dispatch("detectalbums")}
    disabled={detectingAlbums}
    title="Group the photos you're viewing into albums by the pauses between shots — a long gap starts a new album. Preview, rename, then save them into folders (photos and videos)."
  >
    {detectingAlbums
      ? "Detecting…"
      : albumMode
        ? "✕ Auto Albums"
        : "▤ Auto Albums"}
  </button>
</div>

<style>
  .cluster {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
    flex-shrink: 0;
  }
  .reveal-btn {
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    color: inherit;
    font: inherit;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
  }
  .reveal-btn:hover {
    background: #2a2a2a;
  }
  .reveal-btn.active {
    background: #2e8b57;
    border-color: #2e8b57;
    color: #06121f;
    font-weight: 600;
  }
  .reveal-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
