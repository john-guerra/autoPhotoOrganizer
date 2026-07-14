<script>
  /**
   * WHAT YOU DO with the photos the filters left you: show every group in full
   * (or as a strip, or collapsed), jump to where you are, or cut the lot into
   * albums. Presentational — every action is emitted as an event.
   *
   * The Tree/Fisheye toggle used to live here; it went to SidebarModeToggle,
   * directly above the column it switches.
   */
  import { createEventDispatcher } from "svelte";
  import { cycleAllLabel } from "./groupRenderers.js";

  export let cyclingAll = false;
  export let globalViewMode = "full";
  export let albumMode = false;
  export let detectingAlbums = false;

  const dispatch = createEventDispatcher();
</script>

<div class="cluster view">
  <!-- The label is a PROMISE, not a badge: it says what the next click will do,
       not what state you are already in. It used to read "▦ Full view" while
       everything was already in full view — a status report on something shaped
       like a button, so the only way to find out what it did was to press it, and
       pressing it was the thing you were trying to decide about. -->
  <button
    class="reveal-btn cycle-all"
    on:click={() => dispatch("cycleall")}
    disabled={cyclingAll}
    title="Cycle every group: full view → snapshot all → collapse all"
  >
    {cyclingAll ? "…" : cycleAllLabel(globalViewMode)}
  </button>
  <!-- Icon only. It is a nicety, not a headline — you mostly know where you are —
       and it was spending as much of the toolbar as Auto Albums, which is a whole
       feature. The name lives in the tooltip and the accessible label, so nothing
       is lost but the pixels. -->
  <button
    class="reveal-btn icon-only"
    on:click={() => dispatch("revealcurrent")}
    title="Locate — reveal the current photo's folder in the tree"
    aria-label="Locate the current photo in the tree"
  >
    ⌖
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
  .reveal-btn.icon-only {
    padding: 4px 8px;
    font-size: 1rem;
    line-height: 1.1;
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
