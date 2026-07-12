<script>
  // Width-fitted "fisheye" strip: an evenly-distributed sample across the whole
  // group/album (first + last always shown), standing in for it without
  // rendering (or fetching) every row. Two source modes:
  //   - `ids`: an explicit ordered id array (e.g. one album) — sampling runs
  //     client-side, no fetch.
  //   - `groupPath` (+ `groupBy`/`filter`/`sort`): a feed group — samples are
  //     fetched from GET /api/group/sample, which reuses the feed's ORDER BY.
  import { createEventDispatcher } from "svelte";
  import { fetchGroupSample } from "./api.js";
  import { sampleOffsets, slotCount } from "./snapshot.js";
  import SnapshotThumb from "./SnapshotThumb.svelte";

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
  // WIP (issue #90): the strip now renders resilient SnapshotThumb tiles at a
  // shared cache bucket instead of a bare <img> at a unique cold size.
  /** thumbnail longest edge — a shared bucket the grid also caches, so the strip
   * reuses warm thumbnails instead of forcing a unique cold size (issue #90) */
  export let size = 320;
  /** @type {Map<number, number>|null} optional id->mtimeMs for thumb cache-busting */
  export let mtimeById = null;
  /** When true, thumbnails are clickable buttons that dispatch `select`.
   * AlbumsView listens for `select` and routes it through App.svelte's
   * canonical feed-recenter helper (issue #42) rather than duplicating it. */
  export let interactive = true;

  const dispatch = createEventDispatcher();

  // Measured via Svelte's reactive `bind:clientWidth` (fires reliably on mount
  // and on every resize — a hand-rolled ResizeObserver missed the initial
  // layout for strips inserted into the virtualized grid, leaving slots at 0).
  let stripWidth = 0;
  let shown = [];
  let total = count;
  let requestToken = 0;

  // Only the slot COUNT matters; recomputing from width means a sub-thumbnail
  // resize doesn't change `slots` and so doesn't re-sample/re-fetch.
  $: slots = stripWidth > 0 ? slotCount(stripWidth, thumbPx, gapPx) : 0;

  // Mode 1: client-side sampling from an explicit ordered id list.
  $: if (ids) {
    const { offsets, gaps } =
      slots > 0 ? sampleOffsets(ids.length, slots) : { offsets: [], gaps: [] };
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
  bind:clientWidth={stripWidth}
  style="height:{thumbPx}px; gap:{gapPx}px;"
>
  {#each shown as item (item.id)}
    <svelte:element
      this={interactive ? "button" : "div"}
      class="snap-thumb"
      class:static={!interactive}
      style="width:{thumbPx}px; height:{thumbPx}px;"
      role={interactive ? undefined : "presentation"}
      on:click={() => interactive && pick(item.id)}
    >
      <SnapshotThumb id={item.id} {size} v={mtimeById?.get(item.id)} />
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
