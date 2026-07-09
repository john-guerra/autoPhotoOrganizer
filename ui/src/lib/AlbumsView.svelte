<script>
  // Auto-albums review: splits the working set into albums by time gap and
  // shows them as break points (dividers) down the feed. The slider re-clusters
  // instantly (all client-side — see albums.js) so you can preview boundaries
  // before materializing them to dated folders on disk.
  import { createEventDispatcher } from "svelte";
  import { thumbUrl, materializeAlbums } from "./api.js";
  import {
    computeGapStats,
    autoThresholdMs,
    clusterByGap,
    defaultAlbumName,
  } from "./albums.js";

  export let photos = []; // [{id,t,mtimeMs}] time-ordered working set
  export let truncated = false;
  export let hasNativePicker = false;

  const dispatch = createEventDispatcher();

  let k = 2; // threshold = mean + k·stddev (legacy default 2)
  let dest = localStorage.getItem("autogallery.exportDest") || "";
  let materializing = false;
  let result = null;

  $: times = photos.map((p) => p.t);
  $: stats = computeGapStats(times);
  $: thresholdMs = autoThresholdMs(stats, k);
  $: albums = clusterByGap(
    photos.map((p) => ({ id: p.id, t: p.t })),
    thresholdMs
  );
  $: mtimeById = new Map(photos.map((p) => [p.id, p.mtimeMs]));

  function fmtDur(ms) {
    const h = ms / 3600_000;
    if (h < 1) return `${Math.round(ms / 60_000)} min`;
    if (h < 48) return `${h.toFixed(1)} h`;
    return `${(h / 24).toFixed(1)} days`;
  }
  function fmtDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  function albumRange(a) {
    const s = fmtDate(a.startAt);
    const e = fmtDate(a.endAt);
    return s === e ? s : `${s} – ${e}`;
  }

  // Disambiguate album folder names (two albums that start on the same day
  // would otherwise collide): append _2, _3… to later duplicates.
  function namedAlbums() {
    const seen = new Map();
    return albums.map((a) => {
      const base = defaultAlbumName(a.startAt);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { name: n === 1 ? base : `${base}_${n}`, photoIds: a.ids };
    });
  }

  async function pickDest() {
    const p = await window.autogallery?.pickFolder();
    if (p) dest = p;
  }

  async function doMaterialize() {
    if (!dest.trim()) {
      result = { error: "Choose a destination folder first." };
      return;
    }
    materializing = true;
    result = null;
    try {
      result = await materializeAlbums(dest.trim(), namedAlbums());
      localStorage.setItem("autogallery.exportDest", dest.trim());
    } catch (e) {
      result = { error: e.message };
    } finally {
      materializing = false;
    }
  }
</script>

<div class="albums-view">
  <div class="albums-bar">
    <strong>Auto-albums</strong>
    <label class="thresh">
      Split gap
      <input type="range" min="0.5" max="6" step="0.25" bind:value={k} />
      <span class="thresh-val">{k}× · {fmtDur(thresholdMs)}</span>
    </label>
    <span class="albums-count">{albums.length} albums · {photos.length} photos</span>
    <span class="spacer"></span>
    <input
      class="dest"
      type="text"
      placeholder="/materialize/destination"
      bind:value={dest}
      spellcheck="false"
    />
    {#if hasNativePicker}
      <button class="mat-btn" on:click={pickDest}>Choose…</button>
    {/if}
    <button class="mat-btn primary" on:click={doMaterialize} disabled={materializing}>
      {materializing ? "Copying…" : "Materialize to folders"}
    </button>
    <button class="mat-btn" on:click={() => dispatch("close")}>Done</button>
  </div>

  {#if result?.error}
    <p class="albums-msg err">{result.error}</p>
  {:else if result}
    <p class="albums-msg ok">
      Materialized {result.albums.length} album(s) →
      {result.destParent}
    </p>
  {/if}
  {#if truncated}
    <p class="albums-msg warn">
      Showing the first {photos.length.toLocaleString()} photos. Use “Keep only”
      to narrow the working set, then detect albums again.
    </p>
  {/if}

  <div class="albums-scroll">
    {#each albums as album (album.index)}
      <div class="album-divider">
        <span class="album-name">{defaultAlbumName(album.startAt)}</span>
        <span class="album-meta"
          >{album.ids.length} photo{album.ids.length === 1 ? "" : "s"} · {albumRange(
            album
          )}</span
        >
      </div>
      <div class="album-grid">
        {#each album.ids as id (id)}
          <img
            class="album-thumb"
            src={thumbUrl(id, 240, mtimeById.get(id))}
            loading="lazy"
            alt=""
          />
        {/each}
      </div>
    {/each}
  </div>
</div>

<style>
  .albums-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .albums-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: #101010;
    border-bottom: 1px solid #2a2a2a;
    flex-wrap: wrap;
  }
  .thresh {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8rem;
    color: #bbb;
  }
  .thresh input[type="range"] {
    width: 160px;
    accent-color: #4c9aff;
  }
  .thresh-val {
    color: #7fe0a8;
    font-variant-numeric: tabular-nums;
  }
  .albums-count {
    font-size: 0.8rem;
    color: #9a9a9a;
  }
  .spacer {
    flex: 1;
  }
  .dest {
    width: 260px;
    max-width: 40vw;
    padding: 0.35rem 0.5rem;
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 6px;
    color: inherit;
    font-size: 0.8rem;
  }
  .mat-btn {
    background: #222;
    border: 1px solid #3a3a3a;
    color: #e8e8e8;
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .mat-btn.primary {
    background: #2e8b57;
    border-color: #2e8b57;
    color: #06121f;
    font-weight: 600;
  }
  .mat-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .albums-msg {
    margin: 0;
    padding: 6px 12px;
    font-size: 0.8rem;
  }
  .albums-msg.err {
    color: #ff8a80;
    background: #2a1414;
  }
  .albums-msg.ok {
    color: #8fd18f;
    background: #14240f;
  }
  .albums-msg.warn {
    color: #e0c07f;
    background: #241f0f;
  }
  .albums-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 12px 40px;
  }
  .album-divider {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 10px 4px 6px;
    background: linear-gradient(#141414, #141414 70%, transparent);
    border-bottom: 2px solid #2e8b57;
    margin-bottom: 8px;
  }
  .album-name {
    font-weight: 600;
    color: #fff;
  }
  .album-meta {
    font-size: 0.8rem;
    color: #9a9a9a;
  }
  .album-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 18px;
  }
  .album-thumb {
    width: 120px;
    height: 120px;
    object-fit: cover;
    border-radius: 4px;
    background: #1a1a1a;
    display: block;
  }
</style>
