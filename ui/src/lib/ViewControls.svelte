<script>
  /**
   * Toolbar cluster ③: sidebar view toggle (Tree/Fisheye), "Locate current",
   * the global cycle-all-groups control, the Albums toggle, and the zoom +
   * burst sliders. Presentational — sidebarMode/zoom/burst state is two-way
   * bound (App reads them to drive the sidebar, grid row height, and burst
   * clustering); Locate / cycle-all / detect-albums are emitted as events.
   */
  import { createEventDispatcher } from "svelte";

  export let sidebarMode = "tree";
  export let cyclingAll = false;
  export let globalViewMode = "full";
  export let albumMode = false;
  export let detectingAlbums = false;
  export let zoom = 2;
  export let zoomMax = 4;
  export let burstEnabled = true;
  export let burstGapMs = 3000;

  const dispatch = createEventDispatcher();
</script>

<div class="cluster view">
  <div
    class="sidebar-toggle"
    role="group"
    aria-label="Sidebar view"
    style="display:flex;gap:2px;background:#101010;border:1px solid #333;border-radius:6px;padding:2px;"
  >
    <button
      type="button"
      on:click={() => (sidebarMode = "tree")}
      style="border:none;border-radius:4px;padding:3px 9px;font-size:0.8rem;cursor:pointer;{sidebarMode ===
      'tree'
        ? 'background:#4c9aff;color:#06121f;font-weight:600;'
        : 'background:transparent;color:#9a9a9a;'}"
    >
      Tree
    </button>
    <button
      type="button"
      on:click={() => (sidebarMode = "fisheye")}
      style="border:none;border-radius:4px;padding:3px 9px;font-size:0.8rem;cursor:pointer;{sidebarMode ===
      'fisheye'
        ? 'background:#4c9aff;color:#06121f;font-weight:600;'
        : 'background:transparent;color:#9a9a9a;'}"
    >
      Fisheye
    </button>
  </div>
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
    title="Split the current working set into albums by time gaps"
  >
    {detectingAlbums ? "Detecting…" : albumMode ? "✕ Albums" : "▤ Albums"}
  </button>
  <div class="view-cell">
    <label class="zoom" title="Grid zoom (also + / - keys)">
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
  .view-cell {
    display: flex;
    align-items: center;
    gap: 10px;
    background: #141414;
    border: 1px solid #2f2f2f;
    border-radius: 6px;
    padding: 3px 8px;
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
