<script>
  // Auto-albums review: splits the working set into albums by time gap and
  // shows them as break points (dividers) down the feed. The slider re-clusters
  // instantly (all client-side — see albums.js) so you can preview boundaries
  // before materializing them to dated folders on disk.
  import { createEventDispatcher } from "svelte";
  import { startMaterialize } from "./api.js";
  import { waitForJob } from "./jobs.js";
  import {
    computeGapStats,
    autoThresholdMs,
    clusterByGap,
    defaultAlbumName,
  } from "./albums.js";
  import SnapshotStrip from "./SnapshotStrip.svelte";

  export let photos = []; // [{id,t,mtimeMs}] time-ordered working set
  export let truncated = false;
  export let hasNativePicker = false;
  export let limit = 20000; // current working-set cap (server hard-caps at 200000)
  // The folder you've opened (focusPath, #66). When set, materialize defaults
  // to organizing in place — album subfolders created inside this folder.
  export let defaultDest = "";

  const dispatch = createEventDispatcher();

  let k = 2; // threshold = mean + k·stddev (legacy default 2)
  // When the user types an exact split gap, this overrides the k-derived auto
  // threshold (null = follow the slider). Moving the slider clears it.
  let manualThresholdMs = null;
  let editingThresh = false;
  let threshInput = "";
  // Destination: prefer the opened folder (in-place), else the remembered dest.
  let dest = defaultDest || localStorage.getItem("autogallery.exportDest") || "";
  // Track whether the user has hand-edited the destination; until they do, keep
  // it in sync with a changing defaultDest (e.g. focusing a different folder).
  let destEdited = false;
  $: if (!destEdited && defaultDest) dest = defaultDest;
  let materializing = false;
  let result = null;
  // Materialize defaults to MOVE (relocates originals out of the source
  // folders) — Copy is the safer opt-in. A completed/partially-canceled move
  // job can be undone from the JobsPanel via its result manifest.
  let move = true;
  // Local mirror of the max-photos prop. Re-syncs whenever the prop changes
  // (i.e. after a re-fetch clamps it) but survives typing in between.
  let limitInput = limit;
  $: limitInput = limit;

  $: times = photos.map((p) => p.t);
  $: stats = computeGapStats(times);
  $: thresholdMs =
    manualThresholdMs != null ? manualThresholdMs : autoThresholdMs(stats, k);
  $: albums = clusterByGap(
    photos.map((p) => ({ id: p.id, t: p.t })),
    thresholdMs
  );
  $: mtimeById = new Map(photos.map((p) => [p.id, p.mtimeMs]));

  // Editable album folder names, one per cluster. Seeded from the default date
  // name and re-seeded ONLY when the cluster set structurally changes (e.g. the
  // slider re-clusters), so a name you typed survives within one clustering but
  // isn't stale after the boundaries move.
  let names = [];
  let lastAlbumSig = "";
  $: {
    const sig = albums.map((a) => `${a.index}:${a.ids.length}:${a.startAt}`).join("|");
    if (sig !== lastAlbumSig) {
      lastAlbumSig = sig;
      names = albums.map((a) => defaultAlbumName(a.startAt));
    }
  }

  function fmtDur(ms) {
    const h = ms / 3600_000;
    if (h < 1) return `${Math.round(ms / 60_000)} min`;
    if (h < 48) return `${h.toFixed(1)} h`;
    return `${(h / 24).toFixed(1)} days`;
  }

  // Parse a compact duration like "6h", "90m", "2.5d", "1w", or a bare number
  // (interpreted as days) into ms. Returns null on anything unparseable.
  function parseDuration(s) {
    const m = String(s).trim().match(/^([\d.]+)\s*([smhdw]?)$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
    return n * mult[(m[2] || "d").toLowerCase()];
  }

  // Seed the edit field with the current threshold in its most natural unit.
  function threshAsInput(ms) {
    const h = ms / 3600_000;
    if (h < 1) return `${Math.round(ms / 60_000)}m`;
    if (h < 48) return `${(+h.toFixed(1))}h`;
    return `${+(h / 24).toFixed(1)}d`;
  }

  function startEditThresh() {
    threshInput = threshAsInput(thresholdMs);
    editingThresh = true;
  }
  function commitThresh() {
    const ms = parseDuration(threshInput);
    if (ms != null) manualThresholdMs = ms;
    editingThresh = false;
  }
  function onSlider() {
    // Slider is the "auto" control — dragging it drops any manual override.
    manualThresholdMs = null;
  }
  function commitLimit() {
    const v = Math.round(Number(limitInput));
    if (!Number.isFinite(v) || v < 1) {
      limitInput = limit; // reject garbage, restore
      return;
    }
    if (v !== limit) dispatch("relimit", v);
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

  // Build the {name, photoIds} list to materialize from the (user-editable)
  // names. Disambiguate collisions — two albums given the same name (a same-day
  // default, or the user typing a duplicate) would otherwise merge into one
  // folder — by appending _2, _3… to later duplicates.
  function namedAlbums() {
    const seen = new Map();
    return albums.map((a, i) => {
      const typed = (names[i] ?? "").trim();
      const base = typed || defaultAlbumName(a.startAt);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { name: n === 1 ? base : `${base}_${n}`, photoIds: a.ids };
    });
  }

  async function pickDest() {
    const p = await window.autogallery?.pickFolder();
    if (p) dest = p;
  }

  /** Runs as a cancelable background job — live progress shows in the
   * JobsPanel (including a Cancel button and, once done, Undo for a move).
   * This just waits for the terminal result to update the local summary. */
  async function doMaterialize() {
    if (!dest.trim()) {
      result = { error: "Choose a destination folder first." };
      return;
    }
    materializing = true;
    result = null;
    try {
      const { jobId } = await startMaterialize({
        destParent: dest.trim(),
        albums: namedAlbums(),
        move,
      });
      localStorage.setItem("autogallery.exportDest", dest.trim());
      const job = await waitForJob(jobId);
      if (job.status === "done") {
        result = job.result;
      } else if (job.status === "canceled") {
        result = { error: "Materialize canceled." };
      } else {
        result = { error: job.error || "Materialize failed." };
      }
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
    <div class="thresh">
      <!-- Only the slider is wrapped by a <label>. The editable value MUST stay
           outside it: a <label> forwards clicks to its first control (the
           range), which stole focus from the just-opened text field and blurred
           it shut before you could type — issue #70. -->
      <label class="thresh-slider">
        Split gap
        <input
          type="range"
          min="0.5"
          max="6"
          step="0.25"
          bind:value={k}
          on:input={onSlider}
        />
      </label>
      {#if editingThresh}
        <!-- svelte-ignore a11y-autofocus -->
        <input
          class="thresh-edit"
          bind:value={threshInput}
          on:keydown={(e) => {
            if (e.key === "Enter") commitThresh();
            if (e.key === "Escape") (editingThresh = false);
          }}
          on:blur={commitThresh}
          placeholder="e.g. 6h, 2d, 90m"
          autofocus
        />
      {:else}
        <!-- mousedown+preventDefault (not a plain click): opening the editor
             autofocuses the input, but a click's default focus handling would
             immediately blur it back out (on:blur commits + closes), so the
             field flashed and vanished. Preventing the mousedown default keeps
             focus on the input the instant it mounts. on:click stays for
             keyboard activation, where no mousedown precedes it. -->
        <button
          class="thresh-val"
          title="Click to type an exact split gap (e.g. 6h, 2d, 90m)"
          on:mousedown|preventDefault={startEditThresh}
          on:click={startEditThresh}
        >
          {manualThresholdMs != null ? "manual" : `${k}×`} · {fmtDur(thresholdMs)}
        </button>
      {/if}
    </div>
    <span class="albums-count">{albums.length} albums · {photos.length} photos</span>
    <label class="maxphotos" title="Max photos to analyze. Albums render as fisheye snapshot strips, so this stays cheap regardless of size (server caps at 200,000).">
      Max
      <input
        type="number"
        min="100"
        step="500"
        bind:value={limitInput}
        on:change={commitLimit}
        on:keydown={(e) => e.key === "Enter" && commitLimit()}
      />
    </label>
    <span class="spacer"></span>
    <div class="move-toggle" role="radiogroup" aria-label="Move or copy into the album folders">
      <label class="move-opt">
        <input type="radio" name="materialize-mode" value={true} bind:group={move} />
        Move
      </label>
      <label class="move-opt">
        <input type="radio" name="materialize-mode" value={false} bind:group={move} />
        Copy
      </label>
    </div>
    <input
      class="dest"
      type="text"
      placeholder="/materialize/destination"
      bind:value={dest}
      on:input={() => (destEdited = true)}
      spellcheck="false"
    />
    {#if hasNativePicker}
      <button class="mat-btn" on:click={pickDest}>Choose…</button>
    {/if}
    <button class="mat-btn primary" on:click={doMaterialize} disabled={materializing}>
      {materializing
        ? move
          ? "Moving…"
          : "Copying…"
        : `Materialize to folders (${move ? "move" : "copy"})`}
    </button>
    <button class="mat-btn" on:click={() => dispatch("close")}>Done</button>
  </div>

  {#if move}
    <p class="albums-msg warn">
      Move relocates originals out of the source folders — undoable from the jobs panel.
    </p>
  {/if}

  {#if result?.error}
    <p class="albums-msg err">{result.error}</p>
  {:else if result}
    <p class="albums-msg ok">
      {result.move ? "Moved" : "Materialized"} {result.albums.length} album(s) →
      {result.destParent}
    </p>
  {/if}
  {#if truncated}
    <p class="albums-msg warn">
      Showing the first {photos.length.toLocaleString()} photos (Max {limit.toLocaleString()}).
      Raise “Max” above, or use “Keep only” to narrow the working set, then detect
      again.
    </p>
  {/if}

  <div class="albums-scroll">
    {#each albums as album, i (album.index)}
      <div class="album-divider">
        <input
          class="album-name-edit"
          bind:value={names[i]}
          spellcheck="false"
          title="Album folder name (edit before materializing)"
          aria-label="Album folder name"
        />
        <span class="album-meta"
          >{album.ids.length} photo{album.ids.length === 1 ? "" : "s"} · {albumRange(
            album
          )}</span
        >
      </div>
      <div class="album-snapshot">
        <SnapshotStrip ids={album.ids} {mtimeById} on:select={(e) => dispatch("openphoto", e.detail)} />
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
  .thresh-slider {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .thresh input[type="range"] {
    width: 160px;
    accent-color: #4c9aff;
  }
  .thresh-val {
    color: #7fe0a8;
    font-variant-numeric: tabular-nums;
    background: none;
    border: 1px dashed transparent;
    border-radius: 4px;
    padding: 1px 4px;
    font: inherit;
    cursor: text;
  }
  .thresh-val:hover {
    border-color: #3a5a48;
  }
  .thresh-edit {
    width: 90px;
    padding: 2px 5px;
    background: #0d0d0d;
    border: 1px solid #4c9aff;
    border-radius: 4px;
    color: #7fe0a8;
    font: inherit;
    font-variant-numeric: tabular-nums;
  }
  .albums-count {
    font-size: 0.8rem;
    color: #9a9a9a;
  }
  .maxphotos {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    color: #bbb;
  }
  .maxphotos input {
    width: 78px;
    padding: 3px 5px;
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 6px;
    color: inherit;
    font: inherit;
    font-variant-numeric: tabular-nums;
  }
  .spacer {
    flex: 1;
  }
  .move-toggle {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 0.8rem;
    color: #bbb;
  }
  .move-opt {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
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
  .album-name-edit {
    font: inherit;
    font-weight: 600;
    color: #fff;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 5px;
    padding: 2px 6px;
    min-width: 8ch;
    width: auto;
  }
  .album-name-edit:hover {
    border-color: #3a5a48;
  }
  .album-name-edit:focus {
    outline: none;
    background: #0d0d0d;
    border-color: #2e8b57;
  }
  .album-meta {
    font-size: 0.8rem;
    color: #9a9a9a;
  }
  .album-snapshot {
    margin-bottom: 18px;
  }
</style>
