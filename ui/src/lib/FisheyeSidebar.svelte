<script>
  // Fisheye / focus+context library navigator.
  //
  // The layout, the distortion math, the DOI selection, both renderers AND the
  // settings gear now live in @john-guerra/fisheye-nav — a standalone,
  // property-tested widget. What stays here is the part that is genuinely
  // AutoGallery's: fetching the flat tree, this app's label formatting, and
  // translating the widget's {key,value} paths into the feed's
  // {dimension,value} paths.
  import FisheyeNav from "@john-guerra/fisheye-nav/svelte";
  import { fetchFlatTree } from "./api.js";
  import { shortLeafLabel } from "./labels.js";

  let {
    groupBy, // string[]
    currentPath = null, // Array<{dimension,value}> | null — feed position
    filter = null,
    sort = null, // feed sort — date sorts change the date-group order
    refreshToken = 0, // bump to force a reload when the index changes
    onjump,
  } = $props();

  // The lens settings (view, algorithm, distortion, DOI weights, …) are the
  // widget's own — it renders the ⚙ and persists the choices under this key. We
  // pass no `style`/`layout` at all, so the user's saved lens is what loads.
  const SETTINGS_KEY = "autogallery.fisheyeSettings";

  let leaves = $state([]);
  // The groupBy the CURRENT `leaves` were fetched with — NOT the live prop.
  // `groupBy` changes synchronously when you add a dimension, but `leaves` only
  // catches up when the fetch resolves. Handing the widget the new keys over the
  // old rows builds a hierarchy with `month=undefined` levels for a frame. Keys
  // and rows must always come from the same fetch.
  let loadedGroupBy = $state([]);
  let total = $state(0);
  let loadError = $state("");
  let epoch = 0;

  // Reload the whole ordered leaf sequence whenever the hierarchy changes.
  // A leaf's position is only meaningful under the groupBy it was fetched with.
  $effect(() => {
    // loadLeaves reads groupBy itself (as its argument); filter/sort are read
    // inside it (via fetchFlatTree) before its first await, but refreshToken is
    // a pure "bump to reload" signal nothing else reads, so it needs an
    // explicit read here to stay tracked.
    void filter;
    void sort;
    void refreshToken;
    loadLeaves(groupBy);
  });
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
  let rows = $derived(leaves.map((l) => ({ ...l.values, count: l.count })));

  // The widget speaks {key, value}; the feed speaks {dimension, value}.
  const toFeedPath = (path) =>
    path.map((p) => ({ dimension: p.key, value: p.value }));
  const toNavPath = (path) =>
    path?.length
      ? path.map((p) => ({ key: p.dimension, value: p.value }))
      : null;

  let selected = $derived(toNavPath(currentPath));

  // shortLeafLabel only knows folder/year/month/day and returns undefined for
  // anything else (camera, kind, …) — so always fall back to the raw value.
  //
  // A folder row is marked as one here too, so a group reads as a real folder in
  // every navigator. It is a GLYPH, not the <FolderIcon> the feed and the tree
  // draw: FisheyeNav takes `label` as a plain string and renders the text itself,
  // so markup cannot reach it without a change to the widget package. Every
  // fisheye row is a leaf group (the flat tree returns only folders that hold
  // photos), so there is no virtual ancestor here to distinguish.
  const FOLDER_DIMS = new Set(["folder", "folderName"]);
  const FOLDER_GLYPH = "🗀 ";
  const label = (value, key) =>
    (FOLDER_DIMS.has(key) ? FOLDER_GLYPH : "") +
    (shortLeafLabel(key, value) ?? String(value ?? ""));
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
      <button class="retry" onclick={() => loadLeaves(groupBy)}>Retry</button>
    </p>
  {:else}
    <div class="fisheye-body">
      <FisheyeNav
        data={rows}
        keys={loadedGroupBy}
        {selected}
        options={{
          label,
          controls: true,
          persistKey: SETTINGS_KEY,
          // Fill the whole sidebar: the widget keeps 6px of right-edge clearance
          // by default (its `gutter`), which read as wasted space in this narrow,
          // resizable pane. Zero it so the bars reach the divider. (#128)
          gutter: 0,
        }}
        on:select={(e) => onjump?.(toFeedPath(e.detail))}
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
