<script>
  import { onMount, onDestroy } from "svelte";
  import { thumbUrl } from "./api.js";
  import Stars from "./Stars.svelte";

  export let item; // {id, name, rating, mtimeMs}
  export let box; // {x, y, width, height} from the justified layout
  export let pad = 0; // grid frame inset (abs children ignore CSS padding)
  export let size = 640; // thumb longest edge; higher zoom requests sharper
  export let selected = false;

  let el;
  let visible = false; // set true once the tile nears the viewport
  let loaded = false;
  let observer;

  // Recompute the src whenever the tile is visible OR the item/size changes.
  // Svelte reuses this component across rescans (keyed by id), so `item` can
  // swap to a different file under the same id — the mtime version keeps the
  // URL correct.
  $: src = visible ? thumbUrl(item.id, size, item.mtimeMs) : null;
  $: if (src) loaded = false; // re-fade when the source changes

  onMount(() => {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            visible = true;
            observer.disconnect();
          }
        }
      },
      { rootMargin: "400px" } // fetch a bit before it scrolls into view
    );
    observer.observe(el);
  });

  onDestroy(() => observer?.disconnect());

  // Keep the selected tile in view for roving keyboard focus.
  $: if (selected && el) el.scrollIntoView({ block: "nearest" });
</script>

<button
  bind:this={el}
  class="thumb"
  class:selected
  data-id={item.id}
  title={item.name}
  style={`top:${box.y + pad}px;left:${box.x + pad}px;width:${box.width}px;height:${box.height}px;`}
  on:click
>
  {#if src}
    <img
      {src}
      alt={item.name}
      loading="lazy"
      class:loaded
      on:load={() => (loaded = true)}
    />
  {/if}
  {#if item.rating > 0}
    <span class="badge"><Stars rating={item.rating} /></span>
  {/if}
</button>

<style>
  .thumb {
    position: absolute;
    padding: 0;
    border: 2px solid transparent;
    border-radius: 4px;
    overflow: hidden;
    background: #1a1a1a;
    cursor: pointer;
    outline: none;
    transition:
      top 0.15s ease,
      left 0.15s ease,
      width 0.15s ease,
      height 0.15s ease;
  }
  .thumb.selected {
    border-color: #4c9aff;
    box-shadow: 0 0 0 2px rgba(76, 154, 255, 0.35);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  img.loaded {
    opacity: 1;
  }
  .badge {
    position: absolute;
    left: 5px;
    bottom: 5px;
    pointer-events: none;
  }
</style>
