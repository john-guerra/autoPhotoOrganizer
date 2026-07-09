<script>
  // Width-fitted "fisheye" strip: first few + a contiguous middle fragment +
  // last two, standing in for a whole group/album without rendering (or
  // fetching) every row. Two source modes:
  //   - `ids`: an explicit ordered id array (e.g. one album) — sampling runs
  //     client-side, no fetch.
  //   - `groupPath` (+ `groupBy`/`filter`/`sort`): a feed group — samples are
  //     fetched from GET /api/group/sample, which reuses the feed's ORDER BY.
  import { onMount, createEventDispatcher } from "svelte";
  import { thumbUrl, fetchGroupSample } from "./api.js";
  import { sampleOffsets, slotCount } from "./snapshot.js";

  /** @type {number[]|null} ordered id list — client-side sampling */
  export let ids = null;
  /** @type {Array<{dimension:string,value:string}>|null} group path — server-side sampling */
  export let groupPath = null;
  /** @type {number} known/estimated total for groupPath mode, shown before the fetch resolves */
  export let count = 0;
  export let filter = null;
  export let sort = null;
  /** @type {string[]} */
  export let groupBy = [];
  export let thumbPx = 110;
  export let gapPx = 4;
  /** @type {Map<number, number>|null} optional id->mtimeMs for thumb cache-busting */
  export let mtimeById = null;
  /** When true, thumbnails are clickable buttons that dispatch `select`.
   * AlbumsView passes false for now — opening an arbitrary album photo needs
   * a feed-recenter helper (issue #42) we deliberately don't duplicate here. */
  export let interactive = true;

  const dispatch = createEventDispatcher();

  let el;
  let slots = 0;
  let shown = [];
  let total = count;
  let requestToken = 0;

  onMount(() => {
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const next = slotCount(el.clientWidth, thumbPx, gapPx);
      if (next !== slots) slots = next; // guard: skip a no-op resize (avoids re-sample/re-fetch churn)
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  // Mode 1: client-side sampling from an explicit ordered id list.
  $: if (ids) {
    const { offsets, gaps } =
      slots > 0
        ? sampleOffsets(ids.length, slots)
        : { offsets: [], gaps: [] };
    shown = offsets.map((o, i) => ({ id: ids[o], gapAfter: gaps.includes(i) }));
    total = ids.length;
  }

  // Mode 2: server-fetched sampling for a feed group. Guarded with a
  // request token so a slow earlier response can't clobber a later one.
  $: if (!ids && groupPath && slots > 0) {
    loadSample(groupPath, filter, sort, groupBy, slots);
  }

  async function loadSample(path, filterArg, sortArg, groupByArg, slotsArg) {
    const token = ++requestToken;
    try {
      const resp = await fetchGroupSample({
        path,
        groupBy: groupByArg,
        filter: filterArg,
        sort: sortArg,
        slots: slotsArg,
      });
      if (token !== requestToken) return; // superseded by a newer request
      shown = resp.samples.map((s) => ({ id: s.id, gapAfter: s.gapAfter }));
      total = resp.count;
    } catch {
      if (token !== requestToken) return; // superseded — ignore the stale error
      shown = []; // fail quietly: empty strip
    }
  }

  function pick(id) {
    dispatch("select", { id });
  }
</script>

<div
  class="snapshot-strip"
  bind:this={el}
  style="height:{thumbPx}px; gap:{gapPx}px;"
>
  {#each shown as item (item.id)}
    <svelte:element
      this={interactive ? "button" : "div"}
      class="snap-thumb"
      class:static={!interactive}
      style="width:{thumbPx}px; height:{thumbPx}px;"
      on:click={() => interactive && pick(item.id)}
    >
      <img
        src={thumbUrl(item.id, 160, mtimeById?.get(item.id))}
        loading="lazy"
        alt=""
      />
    </svelte:element>
    {#if item.gapAfter}
      <span class="snap-gap">…</span>
    {/if}
  {/each}
  {#if total > 0}
    <span class="snap-count">{total.toLocaleString()}</span>
  {/if}
</div>

<style>
  .snapshot-strip {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    overflow: hidden;
    width: 100%;
  }
  .snap-thumb {
    flex: 0 0 auto;
    padding: 0;
    margin: 0;
    border: 0;
    border-radius: 4px;
    background: #1a1a1a;
    cursor: pointer;
    overflow: hidden;
    display: block;
  }
  .snap-thumb.static {
    cursor: default;
  }
  .snap-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .snap-gap {
    flex: 0 0 auto;
    color: #7a7a7a;
    font-size: 1.1rem;
    padding: 0 2px;
    user-select: none;
  }
  .snap-count {
    flex: 0 0 auto;
    margin-left: auto;
    padding-left: 8px;
    font-size: 0.75rem;
    color: #9a9a9a;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
