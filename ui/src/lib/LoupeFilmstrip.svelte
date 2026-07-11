<script>
  import { createEventDispatcher, tick } from "svelte";
  import { thumbUrl } from "./api.js";
  import { filmstripWindow } from "./filmstrip.js";

  const dispatch = createEventDispatcher();

  export let items = [];
  export let index = 0;
  export let selectedIds = new Set();

  const RADIUS = 40; // ±40 rendered around the current index
  const THUMB = 64; // px

  const isReal = (it) => it && typeof it.id === "number";

  $: win = filmstripWindow(index, items.length, RADIUS);
  // [{ i, item }] for the current window, so click handlers know the real index.
  $: windowItems = Array.from({ length: win.end - win.start }, (_, k) => {
    const i = win.start + k;
    return { i, item: items[i] };
  });

  let stripEl;
  // Keep the current thumb centered horizontally whenever the index changes.
  $: (index, scrollCurrentIntoView());
  async function scrollCurrentIntoView() {
    await tick();
    stripEl?.querySelector(".cell.current")?.scrollIntoView({
      inline: "center",
      block: "nearest",
    });
  }
</script>

<div class="filmstrip" bind:this={stripEl}>
  {#each windowItems as { i, item } (isReal(item) ? item.id : `ph-${i}`)}
    {#if isReal(item)}
      <button
        class="cell"
        class:current={i === index}
        style="width:{THUMB}px;height:{THUMB}px;"
        title={item.name}
        on:click={() => dispatch("select", { index: i })}
      >
        <img src={thumbUrl(item.id, THUMB, item.mtimeMs)} alt={item.name} />
        {#if item.kind === "video"}<span class="badge">▶</span>{/if}
        {#if selectedIds.has(item.id)}<span class="sel">✓</span>{/if}
      </button>
    {:else}
      <div class="gap" style="width:{THUMB / 3}px;height:{THUMB}px;" />
    {/if}
  {/each}
</div>

<style>
  .filmstrip {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 84px;
    padding: 6px 10px;
    overflow-x: auto;
    overflow-y: hidden;
    background: #0d0d0d;
    border-top: 1px solid #222;
  }
  .cell {
    position: relative;
    flex: 0 0 auto;
    padding: 0;
    border: 2px solid transparent;
    border-radius: 4px;
    background: #000;
    cursor: pointer;
    overflow: hidden;
  }
  .cell.current {
    border-color: #4c9dff;
  }
  .cell img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .badge,
  .sel {
    position: absolute;
    font-size: 0.6rem;
    line-height: 1;
    padding: 1px 3px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
  }
  .badge {
    bottom: 2px;
    left: 2px;
  }
  .sel {
    top: 2px;
    right: 2px;
    background: #ffd24c;
    color: #1a1400;
    font-weight: 700;
  }
  .gap {
    flex: 0 0 auto;
  }
</style>
