<script>
  import { createEventDispatcher } from "svelte";
  import { imageUrl, videoUrl, fetchMeta } from "./api.js";
  import LoupeDetails from "./LoupeDetails.svelte";
  import LoupeFilmstrip from "./LoupeFilmstrip.svelte";

  const dispatch = createEventDispatcher();

  // Right-click the photo → let App.svelte open the shared context menu at the
  // cursor, targeting the currently-loupe'd photo.
  function onContextMenu(e) {
    e.preventDefault();
    dispatch("contextmenu", { x: e.clientX, y: e.clientY });
  }

  export let items;
  export let index; // current position in items (two-way bound)
  export let inSelection = false; // is the current photo in the selection?
  export let selectedCount = 0; // total selected, for the panel
  export let selectedIds = new Set(); // for the filmstrip's ✓ markers
  export let showDetails = true;
  export let showFilmstrip = true;

  // `items` is App.svelte's resolvedPhotos — 1:1 with displayEntries, so a
  // collapsed section's placeholder (string id like "collapsed:...") can appear
  // here; `index` may transiently point at one while the caller reassigns.
  const isRealPhoto = (it) => it && typeof it.id === "number";
  $: item = isRealPhoto(items[index]) ? items[index] : null;

  // Lazy, Loupe-scoped full metadata (incl. EXIF): fetch the current photo and
  // its immediate neighbours, cached by id. /api/meta persists on first read,
  // so re-views are instant. This keeps EXIF cost off the grid's enrichMeta.
  const detailMeta = new Map(); // id -> meta object from /api/meta
  let currentMeta = null;
  $: if (item) loadMeta(item.id);

  async function loadMeta(id) {
    currentMeta = detailMeta.get(id) ?? null;
    const ids = [];
    for (let d = -1; d <= 1; d++) {
      const it = items[index + d];
      if (isRealPhoto(it) && !detailMeta.has(it.id)) ids.push(it.id);
    }
    if (!ids.length) return;
    try {
      const metas = await fetchMeta(ids);
      for (const m of metas) detailMeta.set(m.id, m);
      if (item && item.id === id)
        currentMeta = detailMeta.get(id) ?? currentMeta;
    } catch {
      /* metadata is an enhancement; the panel falls back to item fields */
    }
  }

  // Image prefetch: keep ±3 neighbours warm so navigation never waits on decode.
  const warm = new Map(); // id -> Image()
  $: if (item) prefetch(index);
  function prefetch(i) {
    const wanted = new Set();
    for (let d = -3; d <= 3; d++) {
      const it = items[i + d];
      if (!isRealPhoto(it)) continue;
      if (it.kind === "video") continue; // an Image() can't preload a video
      wanted.add(it.id);
      if (!warm.has(it.id)) {
        const img = new Image();
        img.src = imageUrl(it.id, it.mtimeMs);
        warm.set(it.id, img);
      }
    }
    for (const id of warm.keys()) if (!wanted.has(id)) warm.delete(id);
  }
</script>

<div class="loupe" role="dialog" aria-modal="true">
  <div class="body">
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
    {#if showDetails}
      <LoupeDetails {item} meta={currentMeta} {inSelection} {selectedCount} />
    {/if}
  </div>
  {#if showFilmstrip}
    <LoupeFilmstrip
      {items}
      {index}
      {selectedIds}
      on:select={(e) => (index = e.detail.index)}
    />
  {/if}
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
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .stage {
    flex: 1;
    min-width: 0;
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
</style>
