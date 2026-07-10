<script>
  import { createEventDispatcher } from "svelte";
  import { imageUrl, videoUrl } from "./api.js";
  import Stars from "./Stars.svelte";

  const dispatch = createEventDispatcher();

  // Right-click the photo → let App.svelte open the shared context menu at the
  // cursor, targeting the currently-loupe'd photo.
  function onContextMenu(e) {
    e.preventDefault();
    dispatch("contextmenu", { x: e.clientX, y: e.clientY });
  }

  export let items;
  export let index; // current position in items
  export let inSelection = false; // is the current photo in the selection?
  export let selectedCount = 0; // total selected, for the HUD

  // `items` is App.svelte's resolvedPhotos — 1:1 with displayEntries so
  // positional indexing lines up elsewhere, which means a collapsed
  // section's placeholder (a synthetic entry with a string id like
  // "collapsed:...", not a real photo) can appear in this array too.
  // `index` is normally never left pointing at one, but a brief window
  // exists whenever the caller reassigns `items` and only corrects
  // `index` afterward (e.g. after an `await tick()`) — during that gap
  // this two-way-bound `index` can transiently resolve to a placeholder.
  const isRealPhoto = (it) => it && typeof it.id === "number";
  $: item = isRealPhoto(items[index]) ? items[index] : null;

  // Prefetch window: keep ±3 neighbours warm so navigation never waits on decode.
  const warm = new Map(); // id -> Image()
  $: if (item) prefetch(index);

  function prefetch(i) {
    const wanted = new Set();
    for (let d = -3; d <= 3; d++) {
      const it = items[i + d];
      if (!isRealPhoto(it)) continue;
      // An Image() can't preload a video, and pulling whole video files into
      // cache for the ±3 neighbours would be wasteful — skip them.
      if (it.kind === "video") continue;
      wanted.add(it.id);
      if (!warm.has(it.id)) {
        const img = new Image();
        img.src = imageUrl(it.id, it.mtimeMs);
        warm.set(it.id, img);
      }
    }
    // Drop images that fell outside the window.
    for (const id of warm.keys()) {
      if (!wanted.has(id)) warm.delete(id);
    }
  }
</script>

<div class="loupe" role="dialog" aria-modal="true">
  <div class="stage" on:contextmenu={onContextMenu}>
    {#if item}
      {#key item.id}
        {#if item.kind === "video"}
          <!-- muted so the browser doesn't block autoplay; controls give the
               scrub bar that drives the server's Range requests. The {#key}
               tears down/rebuilds the element on navigation, stopping playback. -->
          <video
            src={videoUrl(item.id, item.mtimeMs)}
            controls
            autoplay
            muted
            playsinline
            preload="metadata"
          >
            <track kind="captions" />
          </video>
        {:else}
          <img src={imageUrl(item.id, item.mtimeMs)} alt={item.name} />
        {/if}
      {/key}
    {/if}
  </div>
  <div class="hud">
    <div class="left">
      <span class="name">{item?.name ?? ""}</span>
      <span class="count">{index + 1} of {items.length}</span>
    </div>
    <div class="right">
      <span class="select-state" class:on={inSelection} title="Press X to select">
        {inSelection ? "✓ Selected" : "Press X to select"}
      </span>
      {#if selectedCount > 0}
        <span class="select-total">{selectedCount} selected</span>
      {/if}
      <Stars rating={item?.rating ?? 0} full />
    </div>
  </div>
</div>

<style>
  .loupe {
    position: fixed;
    inset: 0;
    background: #0a0a0a;
    display: flex;
    flex-direction: column;
    z-index: 100;
  }
  .stage {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .stage img,
  .stage video {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    box-shadow: 0 4px 30px rgba(0, 0, 0, 0.6);
  }
  .hud {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.6rem 1rem;
    background: #111;
    border-top: 1px solid #222;
    color: #ddd;
    font-size: 0.85rem;
  }
  .left {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .name {
    color: #fff;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    color: #888;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .select-state {
    font-size: 0.8rem;
    color: #777;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 3px 8px;
  }
  .select-state.on {
    color: #1a1400;
    background: #ffd24c;
    border-color: #ffd24c;
    font-weight: 600;
  }
  .select-total {
    font-size: 0.8rem;
    color: #ffd24c;
  }
</style>
