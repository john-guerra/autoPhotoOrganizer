<script>
  /**
   * A small offline "you are here" map for the loupe's Location section (#175
   * follow-up). Country/region outlines + a dot at the photo's coordinates —
   * NOT a street map. That distinction was a deliberate choice, not a
   * limitation stumbled into: real street-level tiles mean either an online
   * tile service (breaks this feature's "entirely offline, no network"
   * principle — see server/lib/place.js) or bundling a multi-hundred-MB
   * offline tileset. This is d3-geo (already bundled with the project's `d3`
   * dependency) drawing a bundled `world-atlas` topojson file — no network,
   * ever, and consistent with the app's existing d3-based visual style
   * (ui/src/lib/albums.js's timeline).
   *
   * The topojson (~750KB) loads via a dynamic import, not a static one, so it
   * becomes its own Vite chunk fetched only when a geotagged photo is actually
   * viewed — a library with no GPS photos never pays for it, the same
   * lazy-load discipline server/lib/place.js uses for its own dataset.
   *
   * Labels are `smart-labels` (github.com/john-guerra/smart-labels) — a
   * Voronoi-occlusion labeller so only the countries with enough room get a
   * name drawn, rather than 241 overlapping strings.
   */
  import * as d3 from "d3";
  import { feature } from "topojson-client";
  import smartLabels from "smart-labels";

  let { lat, lon, placeName = "", width = 220, height = 140 } = $props();

  /** @type {Array<object> | null} */
  let countries = $state(null);
  let loadError = $state(false);

  $effect(() => {
    if (countries || loadError) return;
    import("world-atlas/countries-50m.json")
      .then((mod) => {
        const world = mod.default ?? mod;
        countries = feature(world, world.objects.countries).features;
      })
      .catch(() => {
        loadError = true;
      });
  });

  // A fixed regional scale, not "fit to country": country polygons vary by
  // orders of magnitude in area (Vatican vs. Russia), so fitting to the
  // photo's own country would make every minimap a different zoom level —
  // the opposite of a quick, scannable "where roughly is this" glance. 900
  // was chosen by eye to show a few hundred km of surrounding context (city
  // + its country's near neighbours) without shrinking small nations to a
  // single pixel.
  const SCALE = 900;
  let projection = $derived(
    d3
      .geoMercator()
      .center([lon, lat])
      .scale(SCALE)
      .translate([width / 2, height / 2])
  );
  let path = $derived(d3.geoPath(projection));
  // The photo's own point projects to the exact centre by construction
  // (center([lon,lat]) puts it there) — computed via the projection anyway,
  // not hardcoded to width/2,height/2, so it stays correct if SCALE/center
  // logic ever changes to something off-centre.
  let dot = $derived(projection([lon, lat]));

  // Only countries whose projected centroid falls within (a small margin of)
  // the VISIBLE box. Two reasons, one of them a bug we hit (#179):
  //   1. world-atlas has 241 countries, and Mercator legitimately diverges to
  //      +/-Infinity near a pole (Antarctica qualifies) — feeding that to
  //      d3-delaunay throws. The Number.isFinite guard below handles that.
  //   2. smart-labels is TOLD the canvas is width×height, so every point we
  //      pass it must actually live on that canvas. A wide margin (this was
  //      once 4 → x from -880 to +1100 on a 220px map) hands it points far
  //      off-screen; it then places their labels off-screen too and draws
  //      anchor lines back across the view — the "leader line to nowhere" of
  //      #179. Keeping the data extent == the canvas is the fix. A hair of
  //      margin lets a label whose centroid sits just past the edge still show.
  const VIEWPORT_MARGIN = 0.1;
  let labelData = $derived.by(() => {
    if (!countries) return [];
    const data = [];
    const xMin = -width * VIEWPORT_MARGIN;
    const xMax = width * (1 + VIEWPORT_MARGIN);
    const yMin = -height * VIEWPORT_MARGIN;
    const yMax = height * (1 + VIEWPORT_MARGIN);
    for (const country of countries) {
      const c = path.centroid(country);
      if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
      if (c[0] < xMin || c[0] > xMax || c[1] < yMin || c[1] > yMax) continue;
      data.push({ x: c[0], y: c[1], name: country.properties?.name ?? "" });
    }
    // The photo's own point, always labelled — it is the whole point of the
    // map, not just another country to compete with for space.
    if (dot && placeName) {
      data.push({ x: dot[0], y: dot[1], name: placeName, isPhoto: true });
    }
    return data;
  });

  /** Svelte action: draws into a `<g>` that ONLY smart-labels ever touches —
   *  it manipulates the DOM directly (d3-style), and letting it share
   *  ownership of an element Svelte also renders into is exactly the
   *  GroupByControl.svelte/multi-auto-select trap this app already learned to
   *  avoid. Re-invoked on every reactive `update`, which is safe: smart-labels
   *  itself joins on a stable `[0]`-keyed root and an index-keyed data array
   *  (see node_modules/smart-labels/dist/smartLabels.es.js), so re-running it
   *  on the SAME node updates existing text elements instead of duplicating
   *  them, as long as `labelData`'s length/order stays stable — which it does,
   *  since `countries` never changes after its one load. */
  function drawLabels(node, data) {
    render(data);
    return { update: render };
    function render(d) {
      if (!d.length) return;
      smartLabels(d, {
        target: node,
        width,
        height,
        x: (p) => p.x,
        y: (p) => p.y,
        label: (p) => p.name,
        hover: false,
        alwaysShow: (p) => p.isPhoto,
        // Place each label AT its point, not in its Voronoi cell's open space.
        // `labelsInCentroids` (default true) offsets labels into free space and
        // draws an anchor line back to the point — right for a big chart, wrong
        // for a 220px "you are here" map, where that anchor is the stray
        // "leader line to nowhere" of #179 and the city label drifts off the
        // pin. false pins "Amagasaki" on the dot. Anchors are gated by
        // `showAnchors || labelsInCentroids`, so BOTH must be off to suppress
        // them (showAnchors already defaults false).
        labelsInCentroids: false,
        showAnchors: false,
        // fill is a single attr on the whole <g class="labels"> (see
        // node_modules/smart-labels/dist/smartLabels.es.js ~line 252) — every
        // label shares one colour, no per-datum override. font DOES vary
        // per-datum (it's applied per <text> element), so the photo's own
        // label is set apart by weight/size instead.
        fill: "#cfe8d8",
        font: (p) => (p.isPhoto ? "bold 11px sans-serif" : "9px sans-serif"),
        threshold: 800,
      });
    }
  }
</script>

<div class="minimap" style={`width:${width}px;height:${height}px;`}>
  {#if loadError}
    <div class="status">Map unavailable</div>
  {:else if !countries}
    <div class="status">Loading map…</div>
  {:else}
    <svg {width} {height} viewBox="0 0 {width} {height}" aria-hidden="true">
      <rect {width} {height} class="ocean" />
      <!-- Index, not country.id: world-atlas's converted GeoJSON leaves .id
           undefined for 5 of its 241 features (small disputed territories with
           no ISO numeric code) — keying on it collided, Svelte's
           each_key_duplicate error. `countries` loads once and is never
           reordered, so an index key is safe here, not the usual anti-pattern. -->
      {#each countries as country, i (i)}
        <path d={path(country)} class="land" />
      {/each}
      {#if dot}
        <circle cx={dot[0]} cy={dot[1]} r="4" class="pin-halo" />
        <circle cx={dot[0]} cy={dot[1]} r="3" class="pin" />
      {/if}
      <!-- No class here: smart-labels creates its OWN "g.labels" as a child
           of this node (see drawLabels below) — naming this wrapper the same
           would nest g.labels inside g.labels, confusing to read even though
           it isn't functionally broken (CSS/locators still match the inner
           one via descendant matching). -->
      <g use:drawLabels={labelData}></g>
    </svg>
  {/if}
</div>

<style>
  .minimap {
    border-radius: 6px;
    overflow: hidden;
    background: #0a1622;
    border: 1px solid #222;
  }
  .status {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #666;
    font-size: 0.75rem;
  }
  .ocean {
    fill: #0a1622;
  }
  .land {
    fill: #2a3a2f;
    stroke: #445446;
    stroke-width: 0.5;
  }
  .pin-halo {
    fill: rgba(255, 210, 76, 0.35);
  }
  .pin {
    fill: #ffd24c;
    stroke: #1a1400;
    stroke-width: 0.75;
  }
  .minimap :global(g.labels text) {
    pointer-events: none;
    paint-order: stroke;
    stroke: #0a1622;
    stroke-width: 2px;
  }
</style>
