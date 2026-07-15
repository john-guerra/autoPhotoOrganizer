<script>
  import { tick } from "svelte";
  import { thumbUrl } from "./api.js";
  import { filmstripWindow } from "./filmstrip.js";
  import { filmstripSegments } from "./filmstripSegments.js";
  import Stars from "./Stars.svelte";
  import BurstOverlay from "./BurstOverlay.svelte";

  /**
   * @type {{
   *   items?: any[],
   *   index?: number,
   *   selectedIds?: Set<number>,
   *   burstInfo?: Array<null | { count: number, stackId: string } | { member: true, stackId: string, isCover: boolean }>,
   *   requestSize?: number,
   *   onselect?: (detail: { index: number }) => void,
   *   ontoggleburst?: (detail: { stackId: string }) => void,
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
   *
   * Bursts are drawn the same way as the feed grid (Thumb.svelte), so a stack
   * reads identically in both: a collapsed cover carries the ×N `.stack-badge`
   * and clicking it EXPANDS the burst (`ontoggleburst`, same control as the
   * feed's cover click); an expanded member carries the `⚏` `.stack-marker`
   * (gold when it's the cover), and a run of members is drawn tight with a
   * connecting line behind them — clicking a member's marker COLLAPSES the burst.
   */
  let {
    items = [],
    index = 0,
    selectedIds = new Set(),
    burstInfo = [],
    requestSize = 64,
    onselect,
    ontoggleburst,
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
  // Consecutive members of one expanded burst → a "run" (tight, connecting line);
  // everything else stands alone. See filmstripSegments.js.
  const segments = $derived(filmstripSegments(windowItems, burstInfo));

  function cellTitle(i, item) {
    const b = burstInfo[i];
    if (b?.count) return `${item.name} — burst of ${b.count} (click to expand)`;
    return item.name;
  }

  /** A cover expands its burst (feed parity: clicking a cover never opens it,
   *  it unfolds it); anything else navigates the loupe to that photo. */
  function onCellClick(i) {
    const b = burstInfo[i];
    if (b?.count) ontoggleburst?.({ stackId: b.stackId });
    else onselect?.({ index: i });
  }

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

{#snippet cell(i, item)}
  <button
    class="cell"
    class:current={i === index}
    class:burst-member={burstInfo[i]?.member}
    style="width:{THUMB}px;height:{THUMB}px;"
    title={cellTitle(i, item)}
    onclick={() => onCellClick(i)}
  >
    <!-- lazy: the strip renders ±40 cells but only ~15 are ever on screen. -->
    <img
      src={thumbUrl(item.id, requestSize, item.mtimeMs)}
      alt={item.name}
      loading="lazy"
      decoding="async"
      width={THUMB}
      height={THUMB}
    />
    {#if item.kind === "video"}<span class="play">▶</span>{/if}
    {#if selectedIds.has(item.id)}<span class="sel">✓</span>{/if}
    {#if item.rating > 0}<span class="rating"><Stars rating={item.rating} /></span
      >{/if}
    <!-- Same overlay glyphs as the feed grid (BurstOverlay). On the cover the
         ×N badge; on an expanded member the ⚏ marker — here it is ALSO the
         collapse control, since the loupe's Escape closes the loupe rather than
         folding the burst. -->
    {#if burstInfo[i]?.count}
      <BurstOverlay count={burstInfo[i].count} />
    {/if}
    {#if burstInfo[i]?.member}
      <BurstOverlay
        member
        isCover={burstInfo[i].isCover}
        markerTitle={burstInfo[i].isCover
          ? "Cover of this burst — click to collapse it"
          : "Part of a burst — click to collapse it"}
        oncollapse={() => ontoggleburst?.({ stackId: burstInfo[i].stackId })}
      />
    {/if}
  </button>
{/snippet}

<div class="filmstrip" bind:this={stripEl}>
  {#each segments as seg, s (seg.type === "run" ? `run-${seg.cells[0].item.id}` : isReal(seg.cell.item) ? seg.cell.item.id : `ph-${s}`)}
    {#if seg.type === "run"}
      <!-- One burst, opened up: members drawn tight with a connecting line
           threaded behind them, so the run reads as a single burst. -->
      <div class="burst-run">
        {#each seg.cells as { i, item } (item.id)}{@render cell(i, item)}{/each}
      </div>
    {:else if isReal(seg.cell.item)}
      {@render cell(seg.cell.i, seg.cell.item)}
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
  /* A burst's members, drawn TIGHT (smaller gap than the 4px between unrelated
     photos) with a connecting line behind them — the loupe's echo of the grid's
     stacked-cards look. The line sits at vertical centre BEHIND the cells
     (z-index 0), so it shows through the tight gaps and stubs out past both ends
     (the horizontal padding), tying the run together. */
  .burst-run {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 6px;
    flex: 0 0 auto;
  }
  .burst-run::before {
    content: "";
    position: absolute;
    top: 50%;
    left: 2px;
    right: 2px;
    height: 2px;
    transform: translateY(-50%);
    background: rgba(76, 154, 255, 0.7);
    border-radius: 1px;
    z-index: 0;
  }
  .cell {
    position: relative;
    z-index: 1; /* above the burst-run connecting line */
    flex: 0 0 auto;
    padding: 0;
    border: 2px solid transparent;
    border-radius: 4px;
    background: #000;
    cursor: pointer;
    overflow: hidden;
    /* Scale BurstOverlay's glyphs down for the 64px cell (feed defaults are 5px
       / 0.7rem, sized for the larger grid tile). Inherited by the overlay. */
    --burst-inset: 2px;
    --burst-pad-x: 4px;
    --burst-font: 0.6rem;
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
  .sel,
  .rating,
  .play {
    position: absolute;
    font-size: 0.6rem;
    line-height: 1;
  }
  /* Selected ✓ — top-right (matches the grid tile). */
  .sel {
    top: 2px;
    right: 2px;
    padding: 1px 3px;
    border-radius: 3px;
    background: #ffd24c;
    color: #1a1400;
    font-weight: 700;
    z-index: 3;
  }
  /* Rating — bottom-left, as on the grid tile, clear of the ×N at bottom-right. */
  .rating {
    bottom: 2px;
    left: 2px;
    z-index: 3;
  }
  /* Video — a centred play glyph, like the grid tile's poster badge. */
  .play {
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 1.2rem;
    height: 1.2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    padding-left: 1px;
    background: rgba(0, 0, 0, 0.5);
    color: #fff;
    border-radius: 50%;
    font-size: 0.5rem;
    z-index: 3;
  }
  .gap {
    flex: 0 0 auto;
  }
</style>
