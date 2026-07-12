<script>
  // Fisheye / focus+context library navigator. A single fixed-height column
  // over the FINEST grouping level of `groupBy`, magnifying where you are
  // (currentPath, from the feed) — the lens follows the feed as you scroll —
  // with outer-level checkpoint bands (year/month) to leap without scrolling.
  // Distortion math lives in the pure, tested lib/fisheye.js; this component is
  // just the view + interaction. Inspired by PhotoRing's navigationList.js.
  import { createEventDispatcher } from "svelte";
  import { pointer } from "d3";
  import { fetchFlatTree } from "./api.js";
  import {
    layoutFisheye,
    makeBarScale,
    FISHEYE_DEFAULTS,
    POSITIONING_MODES,
  } from "./fisheye.js";
  import { shortLeafLabel } from "./labels.js";

  export let groupBy; // string[]
  export let currentPath = null; // Array<{dimension,value}> | null — feed position
  export let filter = null;
  export let sort = null; // feed sort — date sorts change the date-group order
  export let refreshToken = 0; // bump to force a reload when the index changes

  const dispatch = createEventDispatcher();

  // Live-tunable lens settings (algorithm + knobs), persisted. John tunes these.
  const SETTINGS_KEY = "autogallery.fisheyeSettings";
  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  function loadSettings() {
    let raw = {};
    try {
      raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {};
    } catch {
      raw = {};
    }
    return {
      positioning: POSITIONING_MODES.includes(raw.positioning)
        ? raw.positioning
        : FISHEYE_DEFAULTS.positioning,
      distortion: num(raw.distortion, 1, 12, FISHEYE_DEFAULTS.distortion),
      vicinity: Math.round(num(raw.vicinity, 0, 12, FISHEYE_DEFAULTS.vicinity)),
      minRowPx: Math.round(num(raw.minRowPx, 6, 40, FISHEYE_DEFAULTS.minRowPx)),
    };
  }
  let settings = loadSettings();
  let settingsOpen = false;
  $: if (typeof localStorage !== "undefined")
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  function resetSettings() {
    settings = {
      positioning: FISHEYE_DEFAULTS.positioning,
      distortion: FISHEYE_DEFAULTS.distortion,
      vicinity: FISHEYE_DEFAULTS.vicinity,
      minRowPx: FISHEYE_DEFAULTS.minRowPx,
    };
  }
  const LABEL_MIN_PX = 9; // hide ordinary labels on slivers this thin
  const TRACK_X = 14; // left inset of the row track (clears the current-dot gutter)
  const TRACK_W = 210; // row track width; count fill spans 0..TRACK_W

  let leaves = [];
  let total = 0;
  let loadError = "";
  let height = 0; // measured column height
  let svgEl;
  let hoverY = null; // cursor y while hovering → pins the lens focus
  let epoch = 0;

  $: finestDim = groupBy[groupBy.length - 1];

  // Reload the whole ordered leaf sequence whenever the hierarchy changes.
  // A leaf's position is only meaningful under the groupBy it was fetched with.
  $: (filter, sort, refreshToken, loadLeaves(groupBy));
  async function loadLeaves(gb) {
    const mine = ++epoch;
    loadError = "";
    try {
      const res = await fetchFlatTree(gb, filter, sort);
      if (mine !== epoch) return; // superseded by a newer groupBy
      leaves = res.leaves;
      total = res.total;
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

  // The lens focus follows the feed position (currentI); while hovering it
  // pins to the cursor pixel, so the magnified row stays exactly under the
  // pointer — smooth magnification AND reliable clicks (the target never slides
  // away). Either way the fisheye scale keeps every checkpoint on-screen.
  $: layout =
    leaves.length && height
      ? layoutFisheye(leaves, groupBy, {
          height,
          ...(hoverY != null ? { focusPx: hoverY } : { focusI: currentI }),
          positioning: settings.positioning,
          distortion: settings.distortion,
          vicinity: settings.vicinity,
          minRowPx: settings.minRowPx,
        })
      : { rows: [], maxBinCount: 0, focusI: 0 };
  $: barScale = makeBarScale(layout.maxBinCount, TRACK_W);

  function onMove(event) {
    if (svgEl) hoverY = pointer(event, svgEl)[1];
  }
  function onLeave() {
    hoverY = null; // snap the lens back to the current feed position
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
    <button
      class="fisheye-gear"
      class:on={settingsOpen}
      title="Fisheye settings"
      aria-label="Fisheye settings"
      aria-expanded={settingsOpen}
      on:click={() => (settingsOpen = !settingsOpen)}>⚙</button
    >
    <span class="fisheye-total">{total || "…"}</span>
  </div>
  {#if settingsOpen}
    <div class="fisheye-settings">
      <div class="set-row set-algo">
        <span class="set-label">Lens</span>
        <div class="seg" role="radiogroup" aria-label="Positioning algorithm">
          <label class="seg-opt" class:sel={settings.positioning === "rank"}>
            <input
              type="radio"
              bind:group={settings.positioning}
              value="rank"
            />Rank
          </label>
          <label
            class="seg-opt"
            class:sel={settings.positioning === "proportional"}
          >
            <input
              type="radio"
              bind:group={settings.positioning}
              value="proportional"
            />Proportional
          </label>
        </div>
      </div>
      <p class="set-hint">
        {settings.positioning === "rank"
          ? "Even spacing per kept row — the focus stays readable on big lists."
          : "True folder position — dense focus can crush into slivers."}
      </p>
      <label class="set-row">
        <span class="set-label">Distortion</span>
        <input
          type="range"
          min="1"
          max="12"
          step="0.5"
          bind:value={settings.distortion}
        />
        <span class="set-val">{settings.distortion}</span>
      </label>
      <label class="set-row">
        <span class="set-label">Vicinity</span>
        <input
          type="range"
          min="0"
          max="12"
          step="1"
          bind:value={settings.vicinity}
        />
        <span class="set-val">±{settings.vicinity}</span>
      </label>
      <label class="set-row">
        <span class="set-label">Row min</span>
        <input
          type="range"
          min="6"
          max="40"
          step="1"
          bind:value={settings.minRowPx}
        />
        <span class="set-val">{settings.minRowPx}px</span>
      </label>
      <button class="set-reset" on:click={resetSettings}
        >Reset to defaults</button
      >
    </div>
  {/if}
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
          {@const h = Math.max(1, row.thickness - 1.2)}
          {@const showLabel =
            isChk || isCurrent || row.thickness >= LABEL_MIN_PX}
          <g
            class="row"
            class:checkpoint={isChk}
            class:current={isCurrent}
            transform="translate(0,{row.y})"
            on:click={() => onRowClick(row)}
            on:keydown={(e) =>
              (e.key === "Enter" || e.key === " ") &&
              (e.preventDefault(), onRowClick(row))}
            role="option"
            tabindex="-1"
            aria-selected={isCurrent}
          >
            <!-- row band: HEIGHT encodes the fisheye lens (tall at focus) -->
            <rect
              class="band"
              x={TRACK_X}
              y={-h / 2}
              width={TRACK_W}
              height={h}
              rx="2"
            />
            <!-- count fill: LENGTH encodes photo mass (histogram silhouette) -->
            <rect
              class="count"
              x={TRACK_X}
              y={-h / 2}
              width={barScale(row.binCount)}
              height={h}
              rx="2"
            />
            {#if isCurrent}
              <circle class="dot" cx="7" cy="0" r="4" />
            {/if}
            {#if showLabel}
              <text class="lab" x={TRACK_X + 6} y="0">
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
  .fisheye-head {
    gap: 6px;
  }
  .fisheye-title {
    margin-right: auto;
  }
  .fisheye-gear {
    background: none;
    border: none;
    color: #888;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    padding: 0 2px;
    border-radius: 4px;
  }
  .fisheye-gear:hover,
  .fisheye-gear.on {
    color: #cfcfcf;
  }
  .fisheye-settings {
    flex: 0 0 auto;
    padding: 8px;
    border-bottom: 1px solid #2a2a2a;
    background: #141414;
    font-weight: 400;
    font-size: 12px;
  }
  .set-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
  }
  .set-label {
    color: #9a9a9a;
    flex: 0 0 62px;
  }
  .set-row input[type="range"] {
    flex: 1 1 auto;
    min-width: 0;
    accent-color: #4c9aff;
  }
  .set-val {
    color: #cfcfcf;
    flex: 0 0 34px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .seg {
    display: flex;
    flex: 1 1 auto;
    border: 1px solid #333;
    border-radius: 5px;
    overflow: hidden;
  }
  .seg-opt {
    flex: 1 1 0;
    text-align: center;
    padding: 3px 4px;
    color: #9a9a9a;
    cursor: pointer;
  }
  .seg-opt.sel {
    background: #14395e;
    color: #fff;
  }
  .seg-opt input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .set-hint {
    color: #7a7a7a;
    margin: 0 0 6px;
    line-height: 1.3;
  }
  .set-reset {
    margin-top: 4px;
    width: 100%;
    background: #1d1d1d;
    border: 1px solid #333;
    color: #cfcfcf;
    border-radius: 5px;
    padding: 4px;
    cursor: pointer;
  }
  .set-reset:hover {
    background: #262626;
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
  .band {
    fill: #1d1d1d;
  }
  .row:hover .band {
    fill: #262626;
  }
  .count {
    fill: #35506b;
  }
  .row:hover .count {
    fill: #3d5c7c;
  }
  .lab {
    fill: #cfcfcf;
    dominant-baseline: middle;
    pointer-events: none;
  }
  .row.checkpoint .band {
    fill: #2a2010;
  }
  .row.checkpoint .count {
    fill: #6b5320;
  }
  .row.checkpoint .lab {
    fill: #f0c065;
    font-weight: 700;
  }
  .row.current .band {
    fill: #143a5e;
  }
  .row.current .count {
    fill: #2f6aa8;
  }
  .row.current .lab {
    fill: #fff;
    font-weight: 700;
  }
  .dot {
    fill: #4c9aff;
  }
</style>
