<script>
  /**
   * THE FACE MAP (#232) — everyone laid out by how alike their faces are.
   *
   * Grouping splits one human across many person-groups. On a real library
   * that is not an edge case: 25,758 people for 48,585 grouped faces, 20,259
   * of them seen once. The People view (#223) made that visible; merging one
   * dropdown at a time does not scale to 25,758 rows. This makes it fixable in
   * bulk — lasso the blobs that are obviously one person, merge and name them
   * in one action, undoably.
   *
   * A registry view, so it inherits the boundary: it never touches `items`,
   * never runs a feed transaction, and App owns every fetch — including the
   * one that follows a new projection, which is NOT view entry and so is not
   * covered by the working-set loader. The view asks (`onrun`); App does it.
   *
   * The map itself is `ScatterCanvas`, which knows nothing about people. All
   * the domain lives here.
   */
  import ScatterCanvas from "../scatter/ScatterCanvas.svelte";
  import {
    DEFAULT_MIN_RADIUS,
    DEFAULT_MAX_RADIUS,
    RADIUS_LIMITS,
    clampRadius,
  } from "../scatter/lod.js";
  import { loadSetting, saveSetting } from "../settings.js";

  let {
    /** `[{personId, x, y, name, coverFaceId, faces}]` from the current run. */
    points = [],
    /** null until a map has been built. */
    runId = null,
    createdAt = 0,
    algorithm = "umap",
    model = "",
    /** `{detected, grouped, ungrouped, people}` */
    coverage = null,
    /** `{peopleOnMap, peopleNow, missing}` */
    staleness = null,
    /** `{members, algorithms:[{id,label,note,enabled,reason}], params}` */
    options = null,
    /**
     * Person ids the current filter is showing, or `null` for "no filter".
     *
     * Null and empty are deliberately different: empty means the filter
     * matches nobody, and the map must say so rather than quietly showing
     * everyone.
     */
    visiblePersonIds = null,
    loading = false,
    /** Anything App wants said (an error, a confirmation). */
    notice = "",
    /** `(params) => Promise` — App starts the job and refetches. */
    onrun,
    /** `(params) => Promise` — refresh options as the gear changes. */
    onoptions,
    /** `({intoId, ids, name}) => Promise<{ok, error, names?, token?, ...}>` */
    onmerge,
    /** `(token) => Promise` */
    onundo,
    /** `(personId) => void` — narrow the feed to this person. */
    onpick,
    /** `() => void` — jump to grouping. */
    ongroup,
  } = $props();

  // --- the data, as the canvas wants it -----------------------------------
  //
  // Parallel typed arrays built once per `points` identity, not per render:
  // rebuilding 5,499 Float32Arrays on every hover would be the jank the canvas
  // exists to avoid.
  /** The filter as a Set, for O(1) membership in the pack loop. */
  const visibleSet = $derived(
    visiblePersonIds ? new Set(visiblePersonIds) : null
  );

  /**
   * The points the map is currently SHOWING.
   *
   * Filtering hides rather than re-projects, so a person keeps their place
   * whatever you filter to — which is what makes positions comparable across
   * filters and is the whole value of having a map rather than a list.
   */
  const shown = $derived(
    visibleSet ? points.filter((p) => visibleSet.has(p.personId)) : points
  );

  const packed = $derived.by(() => {
    const n = shown.length;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const ids = new Int32Array(n);
    const size = new Float32Array(n);
    const group = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const p = shown[i];
      x[i] = p.x;
      y[i] = p.y;
      ids[i] = p.personId;
      // PHOTOS, not faces: a dot's area says how much of the library this
      // person appears in, and two faces of them in one frame is one photo.
      size[i] = p.photos || p.faces || 1;
      // Named/unnamed is real information here: 6 of 25,758 are named, so
      // "which have I already done" is most of what you want to see.
      group[i] = p.name ? 1 : 0;
    }
    return { x, y, ids, size, group };
  });

  let transform = $state({ k: 1, tx: 0, ty: 0 });
  /** Selected point INDICES — the canvas's currency. */
  let selected = $state(new Set());
  let merging = $state(false);
  let nameDraft = $state("");
  let nameChoices = $state(null);
  let lastUndo = $state(null);

  const n = (v) => (v ?? 0).toLocaleString();
  const chosen = $derived([...selected].map((i) => shown[i]).filter(Boolean));
  const chosenFaces = $derived(chosen.reduce((s, p) => s + (p.faces || 0), 0));
  const chosenNames = $derived([
    ...new Set(chosen.map((p) => p.name).filter((x) => x && x.trim())),
  ]);

  // --- the gear ------------------------------------------------------------
  let gearOpen = $state(false);

  /**
   * Dot size range, in CSS px at base zoom.
   *
   * A DISPLAY setting, not a run parameter: changing it redraws instantly and
   * must not invalidate the cached projection or start a job. Persisted,
   * because the right range depends on how crowded your map is and nobody
   * wants to rediscover it every session.
   */
  let minRadius = $state(
    clampRadius(
      loadSetting("faceMapMinRadius", DEFAULT_MIN_RADIUS),
      DEFAULT_MIN_RADIUS
    )
  );
  let maxRadius = $state(
    clampRadius(
      loadSetting("faceMapMaxRadius", DEFAULT_MAX_RADIUS),
      DEFAULT_MAX_RADIUS
    )
  );
  $effect(() => saveSetting("faceMapMinRadius", minRadius));
  $effect(() => saveSetting("faceMapMaxRadius", maxRadius));
  let minFaces = $state(2);
  let algo = $state("umap");
  let nNeighbors = $state(15);
  let minDist = $state(0.1);

  $effect(() => {
    // Follow the server's clamped values so the gear and the cache key agree —
    // otherwise every request misses the cache forever.
    if (options?.params) {
      minFaces = options.params.minFaces;
      nNeighbors = options.params.nNeighbors;
      minDist = options.params.minDist;
    }
  });

  const currentParams = () => ({
    minFaces,
    nNeighbors,
    minDist,
    algorithm: algo,
  });

  const algoRow = $derived(
    options?.algorithms?.find((a) => a.id === algo) ?? null
  );
  /** ~4s at 5,499 members, ~20s at 25,758 — measured, so the estimate is real. */
  const estimateSeconds = $derived(
    Math.max(2, Math.round(((options?.members ?? 0) / 5499) * 4))
  );

  function applyGear() {
    gearOpen = false;
    selected = new Set();
    onrun?.(currentParams());
  }

  // --- selection -----------------------------------------------------------
  function onLasso(indices, mods) {
    // The pure module owns the set arithmetic (shift adds, alt subtracts) so
    // the rule is unit-tested rather than re-derived here.
    const next = new Set(mods.alt ? selected : mods.shift ? selected : []);
    if (mods.alt) for (const i of indices) next.delete(i);
    else for (const i of indices) next.add(i);
    selected = next;
    nameChoices = null;
    if (chosenNames.length === 1) nameDraft = chosenNames[0];
  }

  function dropFromTray(index) {
    const next = new Set(selected);
    next.delete(index);
    selected = next;
  }

  function clearSelection() {
    selected = new Set();
    nameChoices = null;
    nameDraft = "";
  }

  async function doMerge() {
    if (chosen.length < 2 || merging) return;
    merging = true;
    try {
      // The biggest group is the target: it has the most faces to keep, so it
      // is the least work to undo and the most likely to already be named.
      const target = chosen.reduce((a, b) => (b.faces > a.faces ? b : a));
      const ids = chosen
        .map((p) => p.personId)
        .filter((id) => id !== target.personId);
      const r = await onmerge?.({
        intoId: target.personId,
        ids,
        // Omitted when the user has not typed and there is no single obvious
        // name, so the server can refuse an ambiguous merge rather than
        // silently dropping one.
        ...(nameDraft.trim() || chosenNames.length === 1
          ? { name: nameDraft.trim() || chosenNames[0] }
          : chosenNames.length === 0
            ? { name: null }
            : {}),
      });
      if (r?.names) {
        // The server found two real names and is asking which to keep.
        nameChoices = r.names;
        return;
      }
      if (r?.ok) {
        lastUndo = r.token
          ? { token: r.token, count: r.mergedCount, name: r.name }
          : null;
        clearSelection();
      }
    } finally {
      merging = false;
    }
  }

  function onKey(e) {
    // Declared in the registry's `keys`, so they appear in the shortcuts
    // overlay automatically and App does not answer them with a message about
    // photos.
    if (e.key === "Escape" && selected.size) {
      e.preventDefault();
      clearSelection();
    } else if (e.key === "0") {
      e.preventDefault();
      scatter?.fit();
    }
  }

  let scatter = $state(null);
  const crop = (p) =>
    p?.coverFaceId ? `/api/ml/faces/${p.coverFaceId}/crop?size=160` : null;
</script>

<svelte:window onkeydown={onKey} />

<div class="face-map" data-testid="face-map">
  <header class="bar">
    <h2>Face Map</h2>

    {#if runId}
      <span class="count" data-testid="map-count">
        {#if visibleSet}
          <!-- Never let a filtered map look like the whole library. -->
          {n(shown.length)} of {n(points.length)} people · in view
        {:else}
          {n(points.length)} people · {String(algorithm).toUpperCase()}
        {/if}
      </span>
      {#if staleness?.missing > 0}
        <!-- The join keeps WHO is on the map truthful; only positions age.
             Saying so is the difference between a stale map and a map that
             quietly pretends to be complete. -->
        <span class="warn" data-testid="map-stale">
          {n(staleness.missing)} added since — rebuild to place them
        </span>
      {/if}
    {/if}

    <button
      class="gear"
      data-testid="map-gear"
      aria-expanded={gearOpen}
      onclick={() => {
        gearOpen = !gearOpen;
        if (gearOpen) onoptions?.(currentParams());
      }}
    >
      ⚙ Map settings
    </button>
  </header>

  {#if coverage && coverage.ungrouped > 0}
    <!-- 69,786 of 118,371 faces (59%) were ungrouped on the real library when
         this shipped. Without this line, someone lassos the whole map, merges,
         and reasonably concludes they are finished. -->
    <p class="coverage" data-testid="map-coverage">
      {n(coverage.grouped)} of {n(coverage.detected)} faces are grouped —
      {n(coverage.ungrouped)} have never been through a grouping pass, so they are
      not on this map.
      <button class="link" onclick={() => ongroup?.()}>Group faces</button>
    </p>
  {/if}

  {#if notice}
    <p class="notice" role="status" data-testid="map-notice">{notice}</p>
  {/if}

  {#if lastUndo}
    <p class="undo" role="status" data-testid="map-undo">
      Merged {n(lastUndo.count)}
      {lastUndo.count === 1 ? "person" : "people"}{lastUndo.name
        ? ` into ${lastUndo.name}`
        : ""}.
      <button
        class="link"
        data-testid="map-undo-btn"
        onclick={async () => {
          await onundo?.(lastUndo.token);
          lastUndo = null;
        }}>Undo</button
      >
    </p>
  {/if}

  {#if gearOpen}
    <div class="gear-panel" data-testid="map-gear-panel">
      <label>
        Minimum faces
        <input
          type="number"
          min="1"
          max="50"
          bind:value={minFaces}
          onchange={() => onoptions?.(currentParams())}
        />
      </label>
      <span class="members" data-testid="map-members">
        {n(options?.members)} people · about {estimateSeconds}s
      </span>

      <fieldset>
        <legend>How to lay it out</legend>
        {#each options?.algorithms ?? [] as a (a.id)}
          <label class="algo" class:disabled={!a.enabled}>
            <input
              type="radio"
              name="face-map-algorithm"
              value={a.id}
              disabled={!a.enabled}
              checked={algo === a.id}
              onchange={() => (algo = a.id)}
            />
            <span class="algo-label">{a.label}</span>
            <!-- The measured score, so a menu of three options where two are
                 worse is information rather than a footgun. -->
            <span class="algo-note">{a.enabled ? a.note : a.reason}</span>
          </label>
        {/each}
      </fieldset>

      <fieldset class="sizes">
        <legend>Dot size (px)</legend>
        <label>
          Smallest
          <input
            type="range"
            data-testid="map-min-radius"
            min={RADIUS_LIMITS.min}
            max={20}
            step="0.5"
            bind:value={minRadius}
          />
          <span class="num">{minRadius}</span>
        </label>
        <label>
          Largest
          <input
            type="range"
            data-testid="map-max-radius"
            min={2}
            max={RADIUS_LIMITS.max}
            step="1"
            bind:value={maxRadius}
          />
          <span class="num">{maxRadius}</span>
        </label>
        <!-- Say what the size MEANS, or a slider that changes dot sizes reads
             as decoration rather than an encoding. -->
        <p class="hint">
          Area is proportional to how many photos someone is in, on a
          square-root scale. These apply straight away — they do not rebuild the
          map.
        </p>
      </fieldset>

      <details>
        <summary>Fine tuning</summary>
        <label>
          Neighbours
          <input type="number" min="2" max="200" bind:value={nNeighbors} />
        </label>
        <label>
          Minimum distance
          <input
            type="number"
            min="0"
            max="5"
            step="0.05"
            bind:value={minDist}
          />
        </label>
      </details>

      <button
        class="primary"
        data-testid="map-build"
        onclick={applyGear}
        disabled={loading}
      >
        {loading ? "Building…" : runId ? "Rebuild map" : "Build map"}
      </button>
    </div>
  {/if}

  {#if !runId && !loading}
    <div class="empty" data-testid="map-empty">
      <p class="empty-title">No map yet.</p>
      <p class="empty-hint">
        A map lays out everyone by how alike their faces are, so you can lasso
        the groups that are really one person and merge them in one go.
        {#if options}
          {n(options.members)} people have {minFaces} or more faces — about {estimateSeconds}
          seconds.
        {/if}
      </p>
      <button class="primary" data-testid="map-build-empty" onclick={applyGear}>
        Build the map
      </button>
      <p class="empty-hint small">
        It is kept, so coming back here is instant.
      </p>
    </div>
  {:else}
    {#if visibleSet && shown.length === 0}
      <div class="empty" data-testid="map-filtered-empty">
        <p class="empty-title">Nobody here.</p>
        <p class="empty-hint">
          None of the {n(points.length)} people on the map appear in the photos you
          are viewing. Widen the filter, or clear it, to see everyone again.
        </p>
      </div>
    {/if}
    <div class="canvas-wrap" class:hidden={visibleSet && shown.length === 0}>
      <ScatterCanvas
        bind:this={scatter}
        points={packed}
        bind:transform
        {minRadius}
        {maxRadius}
        highlighted={selected}
        imageFor={(i) => crop(shown[i])}
        labelFor={(i) =>
          `${shown[i]?.name || "Unnamed"} · ${n(shown[i]?.photos)} photo${
            shown[i]?.photos === 1 ? "" : "s"
          } · ${n(shown[i]?.faces)} faces`}
        onlasso={onLasso}
        onpick={(i, e) => {
          if (e.shiftKey || e.altKey) return;
          onpick?.(shown[i]?.personId ?? null);
        }}
      />
      {#if loading}
        <p class="overlay-note">Building the map…</p>
      {/if}
    </div>
  {/if}

  {#if chosen.length}
    <!-- THE REVIEW TRAY. The lasso is a claim ("these are one person") and
         this is where you check it before it becomes durable: a merge marks
         every face person_source='manual' precisely so regrouping will not
         revise it. -->
    <div class="tray" data-testid="map-tray">
      <div class="tray-head">
        <strong data-testid="tray-count">
          {n(chosen.length)} selected · {n(chosenFaces)} faces
        </strong>
        <button class="link" onclick={clearSelection}>Clear</button>
      </div>

      <ul class="tray-list">
        {#each chosen as p, i (p.personId)}
          <li>
            <button
              class="chip"
              data-testid="tray-chip"
              title={`Remove ${p.name || "this person"} from the selection`}
              onclick={() => dropFromTray([...selected][i])}
            >
              {#if crop(p)}
                <img src={crop(p)} alt="" loading="lazy" />
              {:else}
                <span class="chip-initial">?</span>
              {/if}
              <span class="chip-n">{n(p.faces)}</span>
              <span class="chip-x" aria-hidden="true">✕</span>
            </button>
          </li>
        {/each}
      </ul>

      {#if nameChoices}
        <div class="conflict" data-testid="tray-conflict">
          <p>These people have different names. Merging keeps one — which?</p>
          {#each nameChoices as c (c)}
            <button
              class="link"
              onclick={() => {
                nameDraft = c;
                nameChoices = null;
              }}
            >
              {c}
            </button>
          {/each}
        </div>
      {/if}

      <div class="tray-actions">
        <input
          class="name"
          data-testid="tray-name"
          placeholder="Name them (optional)"
          bind:value={nameDraft}
        />
        <button
          class="primary"
          data-testid="tray-merge"
          disabled={chosen.length < 2 || merging}
          onclick={doMerge}
        >
          {merging ? "Merging…" : `Merge ${n(chosen.length)} into one person`}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .face-map {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  .bar {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 8px 12px;
    background: #141414;
    flex: 0 0 auto;
  }
  .bar h2 {
    margin: 0;
    font-size: 1rem;
  }
  .count {
    color: #888;
    font-size: 0.85rem;
  }
  .warn {
    color: #ffd166;
    font-size: 0.8rem;
  }
  .gear {
    margin-left: auto;
    font: inherit;
    font-size: 0.85rem;
    background: #1c1c1c;
    color: inherit;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 3px 10px;
    cursor: pointer;
  }
  .coverage,
  .notice,
  .undo {
    margin: 0;
    padding: 6px 12px;
    font-size: 0.82rem;
    flex: 0 0 auto;
  }
  .coverage {
    background: #1a1710;
    color: #d8c9a0;
  }
  .notice {
    background: #24160f;
    color: #ffb4a2;
  }
  .undo {
    background: #14251c;
    color: #b7e4c7;
  }
  .link {
    font: inherit;
    background: none;
    border: none;
    color: #4c9aff;
    cursor: pointer;
    text-decoration: underline;
    padding: 0 2px;
  }
  .gear-panel {
    background: #171717;
    border-bottom: 1px solid #2a2a2a;
    padding: 10px 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-start;
    flex: 0 0 auto;
  }
  .gear-panel label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 0.8rem;
    color: #bbb;
  }
  .gear-panel input[type="number"] {
    width: 6rem;
    background: #0d0d0d;
    color: #eee;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 3px 6px;
    font: inherit;
  }
  .sizes {
    min-width: 20rem;
  }
  .sizes label {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }
  .sizes input[type="range"] {
    flex: 1 1 auto;
  }
  .num {
    font-variant-numeric: tabular-nums;
    color: #ddd;
    min-width: 2.5rem;
    text-align: right;
  }
  .hint {
    margin: 6px 0 0;
    font-size: 0.75rem;
    color: #888;
    line-height: 1.45;
  }
  .members {
    font-size: 0.8rem;
    color: #888;
    align-self: center;
  }
  fieldset {
    border: 1px solid #2a2a2a;
    border-radius: 6px;
    padding: 6px 10px;
    margin: 0;
    min-width: 22rem;
  }
  legend {
    font-size: 0.78rem;
    color: #888;
    padding: 0 4px;
  }
  .algo {
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: 6px;
    align-items: baseline;
    font-size: 0.8rem;
  }
  .algo.disabled {
    opacity: 0.55;
  }
  .algo-label {
    font-weight: 600;
    color: #ddd;
  }
  .algo-note {
    color: #8a8a8a;
  }
  details summary {
    font-size: 0.8rem;
    color: #888;
    cursor: pointer;
  }
  .primary {
    font: inherit;
    background: #2e8b57;
    border: none;
    color: #06121f;
    font-weight: 600;
    padding: 5px 14px;
    border-radius: 4px;
    cursor: pointer;
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .canvas-wrap {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }
  .canvas-wrap.hidden {
    display: none;
  }
  .overlay-note {
    position: absolute;
    inset: auto 0 12px 0;
    text-align: center;
    color: #aaa;
    font-size: 0.85rem;
    pointer-events: none;
  }
  .empty {
    flex: 1 1 auto;
    display: grid;
    place-content: center;
    text-align: center;
    color: #888;
    padding: 2rem;
    gap: 0.6rem;
  }
  .empty-title {
    font-size: 1rem;
    color: #ccc;
    margin: 0;
  }
  .empty-hint {
    margin: 0;
    max-width: 34rem;
    line-height: 1.55;
    font-size: 0.85rem;
  }
  .empty-hint.small {
    font-size: 0.78rem;
    color: #666;
  }
  .tray {
    flex: 0 0 auto;
    border-top: 1px solid #2a2a2a;
    background: #141414;
    padding: 8px 12px 10px;
    max-height: 34%;
    overflow-y: auto;
  }
  .tray-head {
    display: flex;
    gap: 0.75rem;
    align-items: baseline;
    margin-bottom: 6px;
    font-size: 0.85rem;
  }
  .tray-list {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 0 8px;
    padding: 0;
  }
  .chip {
    position: relative;
    width: 54px;
    height: 54px;
    padding: 0;
    border: 1px solid #333;
    border-radius: 6px;
    overflow: hidden;
    background: #222;
    cursor: pointer;
  }
  .chip:hover {
    border-color: #ff6b6b;
  }
  .chip img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .chip-initial {
    color: #666;
    font-size: 1.2rem;
  }
  .chip-n {
    position: absolute;
    right: 1px;
    bottom: 1px;
    background: #000b;
    color: #ddd;
    font-size: 0.65rem;
    padding: 0 3px;
    border-radius: 3px;
  }
  .chip-x {
    position: absolute;
    left: 2px;
    top: 0;
    color: #ff6b6b;
    font-size: 0.7rem;
    opacity: 0;
  }
  .chip:hover .chip-x {
    opacity: 1;
  }
  .conflict {
    background: #24160f;
    color: #ffb4a2;
    padding: 6px 8px;
    border-radius: 4px;
    font-size: 0.8rem;
    margin-bottom: 8px;
  }
  .conflict p {
    margin: 0 0 4px;
  }
  .tray-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .name {
    font: inherit;
    background: #0d0d0d;
    color: #eee;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 4px 8px;
    min-width: 12rem;
  }
</style>
