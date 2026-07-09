<script>
  // Fisheye / focus+context library navigator. A single fixed-height column
  // over the FINEST grouping level of `groupBy`, magnifying where you are
  // (currentPath, from the feed) and where you point (hover), with outer-level
  // checkpoint bands (year/month) to leap without scrolling. Distortion math
  // lives in the pure, tested lib/fisheye.js; this component is just the view +
  // interaction. Inspired by PhotoRing's navigationList.js.
  import { createEventDispatcher } from "svelte";
  import { pointer } from "d3";
  import { fetchFlatTree } from "./api.js";
  import { layoutFisheye, makeBarScale } from "./fisheye.js";
  import { shortLeafLabel } from "./labels.js";

  export let groupBy; // string[]
  export let currentPath = null; // Array<{dimension,value}> | null — feed position

  const dispatch = createEventDispatcher();
  const LABEL_MIN_PX = 9; // hide ordinary labels on slivers this thin

  let leaves = [];
  let total = 0;
  let loadError = "";
  let height = 0; // measured column height
  let svgEl;
  let hoverI = null; // transient focus under the mouse
  let epoch = 0;

  $: finestDim = groupBy[groupBy.length - 1];

  // Reload the whole ordered leaf sequence whenever the hierarchy changes.
  // A leaf's position is only meaningful under the groupBy it was fetched with.
  $: loadLeaves(groupBy);
  async function loadLeaves(gb) {
    const mine = ++epoch;
    loadError = "";
    try {
      const res = await fetchFlatTree(gb);
      if (mine !== epoch) return; // superseded by a newer groupBy
      leaves = res.leaves;
      total = res.total;
      hoverI = null;
    } catch (e) {
      if (mine !== epoch) return;
      leaves = [];
      total = 0;
      loadError = e.message;
    }
  }

  // Where you ARE: match the feed's current leaf path to an index. Keep the
  // last good index if a transient miss happens (don't snap to 0).
  let currentI = 0;
  $: currentI = resolveCurrentI(currentPath, leaves, currentI);
  function resolveCurrentI(path, ls, prev) {
    if (!path?.length || !ls.length) return prev;
    const idx = ls.findIndex((leaf) =>
      groupBy.every((d) => {
        const p = path.find((x) => x.dimension === d);
        return p ? leaf.values[d] === p.value : true;
      })
    );
    return idx === -1 ? prev : idx;
  }

  // Focus drives the distortion: the hover wins while pointing, else "you are here".
  $: focusI = hoverI ?? currentI;
  $: layout =
    leaves.length && height
      ? layoutFisheye(leaves, groupBy, { height, focusI })
      : { rows: [], maxBinCount: 0 };
  $: barScale = makeBarScale(layout.maxBinCount, 120);

  function onMove(event) {
    if (!svgEl || !layout.rows.length) return;
    const my = pointer(event, svgEl)[1];
    // Snap focus to the rendered row nearest the pointer.
    let best = null;
    let bestDist = Infinity;
    for (const r of layout.rows) {
      const d = Math.abs(r.y - my);
      if (d < bestDist) {
        bestDist = d;
        best = r.i;
      }
    }
    hoverI = best;
  }
  function onLeave() {
    hoverI = null; // snap back to the current position
  }

  function leafPath(row) {
    return groupBy.map((d) => ({ dimension: d, value: row.values[d] }));
  }
  function checkpointPath(row) {
    // Jump to the start of the changed outer level (e.g. the year).
    return groupBy
      .slice(0, row.checkpointDepth + 1)
      .map((d) => ({ dimension: d, value: row.values[d] }));
  }
  function onRowClick(row) {
    dispatch(
      "jump",
      row.checkpointDepth != null ? checkpointPath(row) : leafPath(row)
    );
  }

  // Label text: the differentiating segment, with the previous rendered leaf as
  // context (so days between month bands show just "14", etc.).
  function rowLabel(row, prevRow) {
    if (row.checkpointDepth != null) {
      const dim = groupBy[row.checkpointDepth];
      return shortLeafLabel(dim, row.values[dim]);
    }
    return shortLeafLabel(
      finestDim,
      row.values[finestDim],
      prevRow?.values?.[finestDim]
    );
  }
</script>

<nav class="fisheye" aria-label="Library fisheye">
  <div class="fisheye-head">
    <span class="fisheye-title">Fisheye</span>
    <span class="fisheye-total">{total || "…"}</span>
  </div>
  {#if loadError}
    <div class="fisheye-error">{loadError}</div>
  {:else}
    <div class="fisheye-stage" bind:clientHeight={height}>
      <svg
        bind:this={svgEl}
        class="fisheye-svg"
        width="100%"
        {height}
      on:mousemove={onMove}
      on:mouseleave={onLeave}
      role="listbox"
      tabindex="-1"
    >
      {#each layout.rows as row, j (row.i)}
        {@const isCurrent = row.i === currentI}
        {@const isChk = row.checkpointDepth != null}
        {@const showLabel = isChk || isCurrent || row.thickness >= LABEL_MIN_PX}
        <g
          class="row"
          class:checkpoint={isChk}
          class:current={isCurrent}
          transform="translate(0,{row.y})"
          on:click={() => onRowClick(row)}
          role="option"
          aria-selected={isCurrent}
        >
          <!-- full-width hit target -->
          <rect class="hit" x="0" y={-row.thickness / 2} width="100%" height={row.thickness} />
          <!-- count-weighted bar (histogram silhouette) -->
          <rect
            class="bar"
            x="18"
            y={-Math.max(1, row.thickness - 1.5) / 2}
            width={barScale(row.binCount)}
            height={Math.max(1, row.thickness - 1.5)}
            rx="1.5"
          />
          {#if isCurrent}
            <circle class="dot" cx="8" cy="0" r="4.5" />
          {/if}
          {#if showLabel}
            <text class="lab" x={22 + barScale(row.binCount)} y="0">
              {rowLabel(row, layout.rows[j - 1])}
            </text>
          {/if}
        </g>
      {/each}
      </svg>
    </div>
  {/if}
</nav>

<style>
  .fisheye {
    width: 240px;
    flex: 0 0 240px;
    border-right: 1px solid #2a2a2a;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden; /* fixed height — the whole tree maps onto the column */
    user-select: none;
  }
  .fisheye-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-weight: 700;
    padding: 6px 8px;
    border-bottom: 1px solid #2a2a2a;
    flex: 0 0 auto;
  }
  .fisheye-total {
    color: #888;
    font-size: 0.85em;
    font-weight: 400;
  }
  .fisheye-stage {
    flex: 1 1 auto;
    overflow: hidden; /* fixed height — the whole tree maps onto the column */
    min-height: 0;
  }
  .fisheye-svg {
    display: block;
    cursor: crosshair;
    font:
      12px/1 ui-monospace,
      monospace;
  }
  .fisheye-error {
    color: #ff6b6b;
    padding: 8px;
    font-size: 0.85em;
  }
  .row {
    cursor: pointer;
  }
  .hit {
    fill: transparent;
  }
  .bar {
    fill: #3a3a3a;
  }
  .row:hover .bar {
    fill: #4a4a4a;
  }
  .lab {
    fill: #b8b8b8;
    dominant-baseline: middle;
    pointer-events: none;
  }
  .row.checkpoint .bar {
    fill: #4a3a18;
  }
  .row.checkpoint .lab {
    fill: #e0a94c;
    font-weight: 700;
  }
  .row.current .bar {
    fill: #1e4a72;
  }
  .row.current .lab {
    fill: #fff;
    font-weight: 700;
  }
  .dot {
    fill: #4c9aff;
  }
</style>
