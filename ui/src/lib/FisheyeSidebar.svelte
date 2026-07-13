<script>
  // Fisheye / focus+context library navigator.
  //
  // The layout, the distortion math, the DOI selection and both renderers now
  // live in @john-guerra/fisheye-nav — a standalone, property-tested widget.
  // What stays here is the part that is genuinely AutoGallery's: fetching the
  // flat tree, this app's label formatting, and translating the widget's
  // {key,value} paths into the feed's {dimension,value} paths.
  import { createEventDispatcher } from "svelte";
  import FisheyeNav from "@john-guerra/fisheye-nav/svelte";
  import { fetchFlatTree } from "./api.js";
  import { shortLeafLabel } from "./labels.js";

  export let groupBy; // string[]
  export let currentPath = null; // Array<{dimension,value}> | null — feed position
  export let filter = null;
  export let sort = null; // feed sort — date sorts change the date-group order
  export let refreshToken = 0; // bump to force a reload when the index changes

  const dispatch = createEventDispatcher();

  // Live-tunable lens settings, persisted. John tunes these.
  const SETTINGS_KEY = "autogallery.fisheyeSettings";
  const STYLES = ["flat", "icicle"];
  const LAYOUTS = ["hybrid", "fisheye", "doi", "uniform"];
  const DEFAULTS = {
    style: "flat",
    layout: "hybrid",
    distortion: 4,
    minRowPx: 16,
  };

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
      style: STYLES.includes(raw.style) ? raw.style : DEFAULTS.style,
      layout: LAYOUTS.includes(raw.layout) ? raw.layout : DEFAULTS.layout,
      distortion: num(raw.distortion, 1, 12, DEFAULTS.distortion),
      minRowPx: Math.round(num(raw.minRowPx, 8, 40, DEFAULTS.minRowPx)),
    };
  }
  let settings = loadSettings();
  let settingsOpen = false;
  $: if (typeof localStorage !== "undefined")
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  const resetSettings = () => (settings = { ...DEFAULTS });

  let leaves = [];
  // The groupBy the CURRENT `leaves` were fetched with — NOT the live prop.
  // `groupBy` changes synchronously when you add a dimension, but `leaves` only
  // catches up when the fetch resolves. Handing the widget the new keys over the
  // old rows builds a hierarchy with `month=undefined` levels for a frame. Keys
  // and rows must always come from the same fetch.
  let loadedGroupBy = [];
  let total = 0;
  let loadError = "";
  let epoch = 0;

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
      loadedGroupBy = gb;
      total = res.total;
    } catch (e) {
      if (mine !== epoch) return;
      leaves = [];
      loadedGroupBy = [];
      total = 0;
      loadError = e.message;
    }
  }

  // The server sends `{values: {year, month, day}, count}`; the widget wants a
  // flat row per leaf with the dimensions as plain fields.
  $: rows = leaves.map((l) => ({ ...l.values, count: l.count }));

  // The widget speaks {key, value}; the feed speaks {dimension, value}.
  const toFeedPath = (path) =>
    path.map((p) => ({ dimension: p.key, value: p.value }));
  const toNavPath = (path) =>
    path?.length
      ? path.map((p) => ({ key: p.dimension, value: p.value }))
      : null;

  $: selected = toNavPath(currentPath);

  // shortLeafLabel only knows folder/year/month/day and returns undefined for
  // anything else (camera, kind, …) — so always fall back to the raw value.
  const label = (value, key) =>
    shortLeafLabel(key, value) ?? String(value ?? "");
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
      <div class="set-row">
        <span class="set-label">View</span>
        <div class="seg" role="radiogroup" aria-label="View style">
          <label class="seg-opt" class:sel={settings.style === "flat"}>
            <input type="radio" bind:group={settings.style} value="flat" />List
          </label>
          <label class="seg-opt" class:sel={settings.style === "icicle"}>
            <input
              type="radio"
              bind:group={settings.style}
              value="icicle"
            />Icicle
          </label>
        </div>
      </div>

      <div class="set-row">
        <span class="set-label">Lens</span>
        <select
          class="set-select"
          bind:value={settings.layout}
          aria-label="Lens algorithm"
        >
          <option value="hybrid">Hybrid — magnify + collapse</option>
          <option value="fisheye">Fisheye — every group</option>
          <option value="doi">Interest — full-size rows</option>
          <option value="uniform">Uniform — no lens</option>
        </select>
      </div>

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
        <span class="set-label">Row size</span>
        <input
          type="range"
          min="8"
          max="40"
          step="1"
          bind:value={settings.minRowPx}
        />
        <span class="set-val">{settings.minRowPx}px</span>
      </label>

      <button class="set-reset" on:click={resetSettings}>Reset</button>
    </div>
  {/if}

  {#if loadError}
    <!-- Never fail silently: a dead column tells the user nothing. -->
    <p class="fisheye-error" role="alert">
      Couldn’t load the library outline: {loadError}
      <button class="retry" on:click={() => loadLeaves(groupBy)}>Retry</button>
    </p>
  {:else}
    <div class="fisheye-body">
      <FisheyeNav
        data={rows}
        keys={loadedGroupBy}
        {selected}
        style={settings.style}
        layout={settings.layout}
        options={{
          label,
          distortion: settings.distortion,
          minRowPx: settings.minRowPx,
        }}
        on:select={(e) => dispatch("jump", toFeedPath(e.detail))}
      />
    </div>
  {/if}
</nav>

<style>
  .fisheye {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    position: relative;
  }
  .fisheye-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border, #2a2a2e);
    flex: 0 0 auto;
  }
  .fisheye-title {
    font-size: 12px;
    font-weight: 600;
    flex: 1;
  }
  .fisheye-total {
    font-size: 11px;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
  }
  .fisheye-gear {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.6;
    padding: 0 2px;
    font-size: 12px;
  }
  .fisheye-gear:hover,
  .fisheye-gear.on {
    opacity: 1;
  }
  .fisheye-body {
    flex: 1 1 auto;
    min-height: 0;
  }
  .fisheye-settings {
    padding: 8px;
    border-bottom: 1px solid var(--border, #2a2a2e);
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 11px;
    flex: 0 0 auto;
  }
  .set-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .set-label {
    width: 62px;
    opacity: 0.7;
    flex: 0 0 auto;
  }
  .set-val {
    width: 34px;
    text-align: right;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
  }
  .set-row input[type="range"] {
    flex: 1;
    min-width: 0;
  }
  .set-select {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    background: var(--panel, #1a1a1e);
    color: inherit;
    border: 1px solid var(--border, #2a2a2e);
    border-radius: 4px;
    padding: 2px 4px;
  }
  .seg {
    display: flex;
    gap: 2px;
    flex: 1;
  }
  .seg-opt {
    flex: 1;
    text-align: center;
    padding: 2px 4px;
    border: 1px solid var(--border, #2a2a2e);
    border-radius: 4px;
    cursor: pointer;
    opacity: 0.65;
  }
  .seg-opt.sel {
    opacity: 1;
    border-color: var(--accent, #3b82f6);
    background: color-mix(in oklab, var(--accent, #3b82f6) 18%, transparent);
  }
  .seg-opt input {
    display: none;
  }
  .set-reset {
    align-self: flex-start;
    font-size: 11px;
    background: none;
    border: 1px solid var(--border, #2a2a2e);
    border-radius: 4px;
    color: inherit;
    padding: 2px 8px;
    cursor: pointer;
  }
  .fisheye-error {
    margin: 8px;
    font-size: 11px;
    color: var(--danger, #f87171);
    line-height: 1.4;
  }
  .retry {
    display: block;
    margin-top: 6px;
    font-size: 11px;
    background: none;
    border: 1px solid currentColor;
    border-radius: 4px;
    color: inherit;
    padding: 2px 8px;
    cursor: pointer;
  }
</style>
