<script>
  // Fisheye / focus+context library navigator.
  //
  // The layout, the distortion math, the DOI selection, both renderers AND the
  // settings gear now live in @john-guerra/fisheye-nav — a standalone,
  // property-tested widget. What stays here is the part that is genuinely
  // AutoGallery's: fetching the flat tree, this app's label formatting, and
  // translating the widget's {key,value} paths into the feed's
  // {dimension,value} paths.
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

  // The lens settings (view, algorithm, distortion, DOI weights, …) are the
  // widget's own — it renders the ⚙ and persists the choices under this key. We
  // pass no `style`/`layout` at all, so the user's saved lens is what loads.
  const SETTINGS_KEY = "autogallery.fisheyeSettings";

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
    <span class="fisheye-total">{total || "…"}</span>
  </div>

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
        options={{ label, controls: true, persistKey: SETTINGS_KEY }}
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

    /* The widget's ⚙ popover is the one surface it paints itself, so it can't
       just inherit our colors — it needs a background too, and it defaults to
       the system pair. AutoGallery is dark whatever the OS is set to, so say
       so: this also gives the popover's native selects and sliders dark
       chrome. Custom properties inherit, so this reaches inside the widget. */
    --fn-scheme: dark;
    --fn-panel: var(--panel, #1a1a1e);
    --fn-panel-fg: var(--text, #e8e8e8);
    --fn-accent: var(--accent, #3b82f6);
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
  .fisheye-body {
    flex: 1 1 auto;
    min-height: 0;
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
