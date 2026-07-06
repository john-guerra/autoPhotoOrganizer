<script context="module">
  export const PEEK_STEP_PX = 6; // px offset per peeking layer (diagonal: horizontal alternating + vertical), tuned for visibility
  export const MAX_PEEK_DEPTH = 2; // visual depth cap — peeks beyond this render at the same max offset, keeping the tile's footprint small and neat regardless of actual stack size
  export const PEEK_VERTICAL_PX = 1; // flat vertical offset for every peek layer (not scaled by depth) — a subtle "slightly offset" cue, kept tiny since it isn't reserved for in the grid layout
</script>

<script>
  import { onMount, onDestroy } from "svelte";
  import { thumbUrl } from "./api.js";
  import Stars from "./Stars.svelte";

  export let item; // {id, name, rating, mtimeMs}
  export let box; // {x, y, width, height} from the justified layout
  export let pad = 0; // grid frame inset (abs children ignore CSS padding)
  export let size = 640; // thumb longest edge; higher zoom requests sharper
  export let selected = false;
  export let stackCount = undefined; // set when this tile is a collapsed stack's cover
  export let inExpandedStack = false; // true when this photo is a member of a currently-expanded stack
  export let isCurrentCover = false; // true when this expanded member currently resolves as its stack's cover
  export let stackPeekItems = []; // this stack's other members (excludes the cover), for the peeking-photos visual
  export let stackMarginPx = 0; // horizontal margin reserved in the layout for this stack's peek layers (0 for non-stack tiles)

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

  // Split alternately: chronologically-nearer non-cover members peek out
  // closer to the cover (right first, then left, then right again, ...).
  $: rightPeekItems = stackPeekItems.filter((_, i) => i % 2 === 0);
  $: leftPeekItems = stackPeekItems.filter((_, i) => i % 2 === 1);

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

<div
  class="thumb-wrap"
  style={`top:${box.y + pad}px;left:${box.x + pad}px;width:${box.width}px;height:${box.height}px;`}
>
  {#if src}
    {#each rightPeekItems as peekItem, i (peekItem.id)}
      <img
        src={thumbUrl(peekItem.id, size, peekItem.mtimeMs)}
        alt=""
        loading="lazy"
        class="stack-peek"
        style={`inset: 0 ${stackMarginPx}px; transform: translate(${Math.min(i + 1, MAX_PEEK_DEPTH) * PEEK_STEP_PX}px, ${PEEK_VERTICAL_PX}px); z-index: ${rightPeekItems.length - i};`}
      />
    {/each}
    {#each leftPeekItems as peekItem, i (peekItem.id)}
      <img
        src={thumbUrl(peekItem.id, size, peekItem.mtimeMs)}
        alt=""
        loading="lazy"
        class="stack-peek"
        style={`inset: 0 ${stackMarginPx}px; transform: translate(${-Math.min(i + 1, MAX_PEEK_DEPTH) * PEEK_STEP_PX}px, ${PEEK_VERTICAL_PX}px); z-index: ${leftPeekItems.length - i};`}
      />
    {/each}
  {/if}
  <button
    bind:this={el}
    class="thumb"
    class:selected
    data-id={item.id}
    title={item.name}
    style={stackMarginPx ? `inset: 0 ${stackMarginPx}px;` : ""}
    on:click
  >
    {#if src}
      <img
        {src}
        alt={item.name}
        loading="lazy"
        class="cover"
        class:loaded
        on:load={() => (loaded = true)}
      />
    {/if}
    {#if item.rating > 0}
      <span class="badge"><Stars rating={item.rating} /></span>
    {/if}
    {#if stackCount}
      <span class="stack-badge">×{stackCount}</span>
    {/if}
    {#if inExpandedStack}
      <span
        class="stack-marker"
        class:is-cover={isCurrentCover}
        title={isCurrentCover
          ? "Current cover for this stack — press C to unset, Escape to collapse"
          : "Part of a burst — press C to make this the cover, Escape to collapse"}>⚏</span
      >
    {/if}
  </button>
</div>

<style>
  .thumb-wrap {
    position: absolute;
    transition:
      top 0.15s ease,
      left 0.15s ease,
      width 0.15s ease,
      height 0.15s ease;
  }
  .thumb {
    position: absolute;
    inset: 0;
    padding: 0;
    border: 2px solid transparent;
    border-radius: 4px;
    overflow: hidden;
    background: #1a1a1a;
    cursor: pointer;
    outline: none;
  }
  .thumb.selected {
    border-color: #4c9aff;
    box-shadow: 0 0 0 2px rgba(76, 154, 255, 0.35);
  }
  img.cover,
  .stack-peek {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    border-radius: inherit;
  }
  img.cover {
    z-index: 50;
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  img.cover.loaded {
    opacity: 1;
  }
  .stack-peek {
    filter: brightness(0.75);
    pointer-events: none;
  }
  .badge {
    position: absolute;
    left: 5px;
    bottom: 5px;
    pointer-events: none;
  }
  .stack-badge {
    position: absolute;
    right: 5px;
    bottom: 5px;
    padding: 1px 5px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    font-size: 0.7rem;
    border-radius: 3px;
    pointer-events: none;
  }
  .stack-marker {
    position: absolute;
    left: 5px;
    top: 5px;
    padding: 1px 4px;
    background: rgba(76, 154, 255, 0.75);
    color: #06121f;
    font-size: 0.7rem;
    border-radius: 3px;
    pointer-events: none;
  }
  .stack-marker.is-cover {
    background: rgba(255, 196, 0, 0.85);
  }
  .badge,
  .stack-badge,
  .stack-marker {
    z-index: 100;
  }
</style>
