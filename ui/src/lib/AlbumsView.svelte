<script>
  // Auto-albums review: splits the working set into albums by time gap and
  // shows them as break points (dividers) down the feed. The slider re-clusters
  // instantly (all client-side — see albums.js) so you can preview boundaries
  // before materializing them to dated folders on disk.
  import { createEventDispatcher, onMount } from "svelte";
  import {
    startMaterialize,
    fetchSystemPaths,
    checkSameVolume,
  } from "./api.js";
  import { waitForJob } from "./jobs.js";
  import {
    computeGapStats,
    autoThresholdMs,
    clusterByGap,
    defaultAlbumName,
    computeAlbumNames,
    parseDuration,
    fmtDur,
    threshAsInput,
  } from "./albums.js";
  import SnapshotStrip from "./SnapshotStrip.svelte";
  import AlbumsSetupModal from "./AlbumsSetupModal.svelte";

  export let photos = []; // [{id,t,mtimeMs}] time-ordered working set
  export let truncated = false;
  export let hasNativePicker = false;
  export let limit = 20000; // current working-set cap (server hard-caps at 200000)
  // The folder you're currently working in — focusPath if focused, else
  // derived from the current groupBy position, else the first album photo's
  // own folder (see App.svelte's `currentFolder`, #66). When set, materialize
  // defaults to organizing in place — album subfolders created inside this
  // folder.
  export let defaultDest = "";
  // The current folder's basename (App passes `currentFolderName`), used as
  // the default "<folderName>_<n>" album name when the naming template is
  // empty. Source-specific, so it is NOT persisted to the global album prefs
  // (unlike `template`, which is).
  export let currentFolderName = "";
  // Global album prefs (template/gapMode/fixedGapMs/k/move) — see albumPrefs.js.
  // AlbumsView owns the LIVE working copy (seeded here, tweaked by the slider,
  // the Auto button, the type-exact editor, and the Options modal); App
  // persists it back on `prefschange`.
  export let prefs;
  // Open the setup/explainer modal automatically the very first time Auto
  // Albums is EVER entered (App persists this to localStorage, so it never
  // reopens automatically again after that one time); afterward it's only
  // reachable via the ⚙ Options button. Seeded at mount from this prop.
  export let autoOpenSetup = false;

  const dispatch = createEventDispatcher();

  // Single authoritative gap state — gapMode/fixedGapMs/k. Every control
  // (slider, Auto button, type-exact editor, Options modal) reads/writes
  // these same three fields; there is no parallel threshold path.
  let gapMode = prefs.gapMode; // "fixed" | "auto"
  let fixedGapMs = prefs.fixedGapMs;
  let k = prefs.k; // auto-mode multiplier: threshold = mean + k·stddev
  let editingThresh = false;
  let threshInput = "";
  // Local mirror of the naming template, kept in sync via the Options modal's
  // `apply` (prefs.template itself only updates once App persists+re-passes).
  let template = prefs.template;
  let setupOpen = autoOpenSetup;
  // Destination: default to the opened folder (in-place) so Move creates album
  // subfolders directly inside the folder you're viewing. When you're not
  // focused on a folder it starts empty (rather than a stale remembered path
  // that could be a parent) — the mode-dependent block below then fills Copy's
  // default with the Desktop.
  let dest = defaultDest || "";
  // Track whether the user has hand-edited the destination; until they do, keep
  // it mode-dependent (see reactive block below) instead of a fixed value.
  let destEdited = false;
  let materializing = false;
  let result = null;
  // Materialize defaults to MOVE (relocates the originals into the album
  // folders — by default subfolders of the folder you're viewing) — Copy is
  // the safer opt-in. A completed/partially-canceled move job can be undone
  // from the JobsPanel via its result manifest.
  let move = prefs.move;

  // Desktop path for Copy's default destination (fetched once; harmless if it
  // never resolves — the field just keeps whatever it was seeded with).
  let desktopPath = "";
  onMount(async () => {
    try {
      const { desktop } = await fetchSystemPaths();
      desktopPath = desktop || "";
    } catch {
      // non-fatal: Copy's smart default just won't kick in
    }
  });

  // Mode-dependent dest default: Move organizes in place (the opened
  // folder/source), Copy defaults to the Desktop — switching the toggle
  // updates the field only while the user hasn't hand-typed a dest.
  $: if (!destEdited) {
    if (move) {
      if (defaultDest) dest = defaultDest;
    } else if (desktopPath) {
      dest = desktopPath;
    }
  }

  // Cross-volume Move warning: a Move across volumes can't be a cheap
  // rename — materialize falls back to copy+delete, which is slow and not
  // an instant move. `sameVolume` is null while unknown/unchecked.
  let sameVolume = null;
  let volumeCheckToken = 0;
  $: if (move && dest.trim() && defaultDest) {
    checkVolume(defaultDest, dest.trim());
  } else {
    sameVolume = null;
  }
  async function checkVolume(source, destPath) {
    const token = ++volumeCheckToken;
    try {
      const { sameVolume: sv } = await checkSameVolume(source, destPath);
      if (token === volumeCheckToken) sameVolume = sv;
    } catch {
      if (token === volumeCheckToken) sameVolume = null;
    }
  }
  // Local mirror of the max-photos prop. Re-syncs whenever the prop changes
  // (i.e. after a re-fetch clamps it) but survives typing in between.
  let limitInput = limit;
  $: limitInput = limit;

  $: times = photos.map((p) => p.t);
  $: stats = computeGapStats(times);
  $: thresholdMs = gapMode === "auto" ? autoThresholdMs(stats, k) : fixedGapMs;
  $: albums = clusterByGap(
    photos.map((p) => ({ id: p.id, t: p.t })),
    thresholdMs
  );
  $: mtimeById = new Map(photos.map((p) => [p.id, p.mtimeMs]));

  // Editable album folder names, keyed by each album's first-photo id so a
  // typed name survives re-clustering (slider/Auto move boundaries) as long
  // as that photo still starts the album. Un-edited albums render from
  // `template`.
  let editedNames = new Map(); // firstPhotoId -> typed name
  $: names = computeAlbumNames(
    albums,
    editedNames,
    template,
    currentFolderName
  );

  function onNameInput(i, value) {
    const firstId = albums[i].ids[0];
    if (value == null || value === "") editedNames.delete(firstId);
    else editedNames.set(firstId, value);
    editedNames = editedNames; // trigger Svelte reactivity
  }

  // Bound album-name <input> elements, indexed like `albums`/`names` — lets
  // plain Tab/Shift+Tab jump straight between name fields (issue #2) instead
  // of tabbing through every snapshot thumbnail in between.
  let nameInputs = [];
  function onNameKeydown(e, i) {
    if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
    const next = e.shiftKey ? i - 1 : i + 1;
    const target = nameInputs[next];
    if (!target) return; // stop at the ends
    e.preventDefault();
    target.focus();
    target.select();
  }

  function startEditThresh() {
    threshInput = threshAsInput(thresholdMs);
    editingThresh = true;
  }
  function commitThresh() {
    const ms = parseDuration(threshInput);
    if (ms != null) {
      fixedGapMs = ms;
      gapMode = "fixed";
    }
    editingThresh = false;
  }
  function onSlider() {
    // The k slider tunes the auto threshold (mean + k·stddev) — dragging it
    // switches into auto mode.
    gapMode = "auto";
  }
  function useAuto() {
    gapMode = "auto";
  }

  function onSetupApply(e) {
    const p = e.detail;
    gapMode = p.gapMode;
    fixedGapMs = p.fixedGapMs;
    move = p.move;
    dest = p.dest || dest;
    template = p.template;
    // Persist globally (App writes to albumPrefs.js / localStorage).
    dispatch("prefschange", p);
    setupOpen = false;
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
        // Tell App to rescan the destination so the newly-created album
        // folders index and show up in the sidebar tree right away.
        dispatch("materialized", { destParent: dest.trim() });
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
      <button
        class="mat-btn"
        class:active={gapMode === "auto"}
        on:click={useAuto}
        title="Pick the split gap automatically (mean + k·stddev)"
      >
        Auto
      </button>
      {#if editingThresh}
        <!-- svelte-ignore a11y-autofocus -->
        <input
          class="thresh-edit"
          bind:value={threshInput}
          on:keydown={(e) => {
            if (e.key === "Enter") commitThresh();
            if (e.key === "Escape") editingThresh = false;
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
          {gapMode === "fixed" ? "fixed" : `${k}×`} · {fmtDur(thresholdMs)}
        </button>
      {/if}
    </div>
    <span class="albums-count"
      >{albums.length} albums · {photos.length} photos</span
    >
    <label
      class="maxphotos"
      title="Max photos to analyze. Albums render as fisheye snapshot strips, so this stays cheap regardless of size (server caps at 200,000)."
    >
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
    <div
      class="move-toggle"
      role="radiogroup"
      aria-label="Move or copy into the album folders"
    >
      <label class="move-opt">
        <input
          type="radio"
          name="materialize-mode"
          value={true}
          bind:group={move}
        />
        Move
      </label>
      <label class="move-opt">
        <input
          type="radio"
          name="materialize-mode"
          value={false}
          bind:group={move}
        />
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
    <button
      class="mat-btn primary"
      on:click={doMaterialize}
      disabled={materializing}
    >
      {materializing
        ? move
          ? "Moving…"
          : "Copying…"
        : `Materialize to folders (${move ? "move" : "copy"})`}
    </button>
    <button
      class="mat-btn"
      on:click={() => (setupOpen = true)}
      title="Naming & gap options"
    >
      ⚙ Options
    </button>
    <button class="mat-btn" on:click={() => dispatch("close")}>Done</button>
  </div>

  {#if move}
    <p class="albums-msg warn">
      Move relocates the originals into the album folders (not a copy) —
      undoable from the jobs panel.
    </p>
  {/if}
  {#if move && sameVolume === false}
    <p class="albums-msg warn">
      Different volume — this Move copies every file, it's not an instant move.
    </p>
  {/if}

  {#if result?.error}
    <p class="albums-msg err">{result.error}</p>
  {:else if result}
    <p class="albums-msg ok">
      {result.move ? "Moved" : "Materialized"}
      {result.albums.length} album(s) →
      {result.destParent}
    </p>
  {/if}
  {#if truncated}
    <p class="albums-msg warn">
      Showing the first {photos.length.toLocaleString()} photos (Max {limit.toLocaleString()}).
      Raise “Max” above, or use “Keep only” to narrow the working set, then
      detect again.
    </p>
  {/if}

  <div class="albums-scroll">
    {#each albums as album, i (album.index)}
      <div class="album-divider">
        <input
          class="album-name-edit"
          bind:this={nameInputs[i]}
          value={names[i]}
          on:input={(e) => onNameInput(i, e.target.value)}
          on:keydown={(e) => onNameKeydown(e, i)}
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
        <SnapshotStrip
          ids={album.ids}
          {mtimeById}
          on:select={(e) => dispatch("openphoto", e.detail)}
        />
      </div>
    {/each}
  </div>
</div>

<AlbumsSetupModal
  bind:open={setupOpen}
  {prefs}
  sampleDate={new Date(albums[0]?.startAt ?? Date.now())}
  {dest}
  {hasNativePicker}
  {currentFolderName}
  on:apply={onSetupApply}
/>

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
  .mat-btn.primary,
  .mat-btn.active {
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
