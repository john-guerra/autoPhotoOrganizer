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
   */
  import * as d3 from "d3";
  import { feature } from "topojson-client";

  let { lat, lon, width = 220, height = 140 } = $props();

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
</style>
