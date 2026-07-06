<script>
  import { imageUrl } from "./api.js";
  import Stars from "./Stars.svelte";

  export let items;
  export let index; // current position in items

  $: item = items[index];

  // Prefetch window: keep ±3 neighbours warm so navigation never waits on decode.
  const warm = new Map(); // id -> Image()
  $: if (item) prefetch(index);

  function prefetch(i) {
    const wanted = new Set();
    for (let d = -3; d <= 3; d++) {
      const it = items[i + d];
      if (!it) continue;
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
  <div class="stage">
    {#key item.id}
      <img src={imageUrl(item.id, item.mtimeMs)} alt={item.name} />
    {/key}
  </div>
  <div class="hud">
    <div class="left">
      <span class="name">{item.name}</span>
      <span class="count">{index + 1} of {items.length}</span>
    </div>
    <Stars rating={item.rating} full />
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
  .stage img {
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
</style>
