<script>
  import { tick } from "svelte";
  import { thumbUrl } from "./api.js";
  import { filmstripWindow } from "./filmstrip.js";
  import Stars from "./Stars.svelte";

  /**
   * @type {{
   *   items?: any[],
   *   index?: number,
   *   selectedIds?: Set<number>,
   *   requestSize?: number,
   *   onselect?: (detail: { index: number }) => void,
   * }}
   * `requestSize` is the thumbnail size to REQUEST — the grid's current one, not
   * the 64px this strip draws at.
   *
   * The thumb cache is keyed by exact pixel size, so asking for 64 (a size no
   * other view uses) meant every loupe open generated up to 81 brand-new
   * thumbnails, at the very moment the loupe also wants its full-size image and
   * its ±3 prefetch. Asking for the size the GRID just used makes every one of
   * them a cache hit — server-side, and in the browser (the thumb URL is
   * immutable and already fetched). Bigger bytes, but bytes we already have,
   * versus decoding the photo again. Drawn at 64px by CSS either way.
   */
  let {
    items = [],
    index = 0,
    selectedIds = new Set(),
    requestSize = 64,
    onselect,
  } = $props();

  const RADIUS = 40; // ±40 rendered around the current index
  const THUMB = 64; // px — the drawn size

  const isReal = (it) => it && typeof it.id === "number";

  const win = $derived(filmstripWindow(index, items.length, RADIUS));
  // [{ i, item }] for the current window, so click handlers know the real index.
  const windowItems = $derived(
    Array.from({ length: win.end - win.start }, (_, k) => {
      const i = win.start + k;
      return { i, item: items[i] };
    })
  );

  let stripEl;
  // Keep the current thumb centered horizontally whenever the index changes.
  $effect(() => {
    void index; // track the current position
    scrollCurrentIntoView();
  });
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
        onclick={() => onselect?.({ index: i })}
      >
        <!-- lazy: the strip renders ±40 cells but only ~15 are ever on screen.
             Eagerly fetching all 81 put a thundering herd in front of the one
             image the user is actually waiting for — the full-size photo. -->
        <img
          src={thumbUrl(item.id, requestSize, item.mtimeMs)}
          alt={item.name}
          loading="lazy"
          decoding="async"
          width={THUMB}
          height={THUMB}
        />
        {#if item.kind === "video"}<span class="badge">▶</span>{/if}
        {#if selectedIds.has(item.id)}<span class="sel">✓</span>{/if}
        {#if item.rating > 0}<span class="rating"
            ><Stars rating={item.rating} /></span
          >{/if}
      </button>
    {:else}
      <div class="gap" style="width:{THUMB / 3}px;height:{THUMB}px;"></div>
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
  /* Rating pill: bottom-right, out of the way of the ✓ (top-right) and the
     ▶ video badge (bottom-left). Stars.svelte brings its own dark pill. */
  .rating {
    position: absolute;
    bottom: 2px;
    right: 2px;
    line-height: 1;
  }
  .gap {
    flex: 0 0 auto;
  }
</style>
