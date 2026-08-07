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
  import { untrack } from "svelte";
  import { faceCropUrl } from "../faceCropUrl.js";
  import { isTypingTarget } from "../focus.js";
  import ScatterCanvas from "../scatter/ScatterCanvas.svelte";
  import {
    DEFAULT_MIN_RADIUS,
    DEFAULT_MAX_RADIUS,
    RADIUS_LIMITS,
    clampRadius,
  } from "../scatter/lod.js";
  import { loadSetting, saveSetting } from "../settings.js";
  import ParamSlider from "../ParamSlider.svelte";
  import {
    similarityFrom,
    applySimilarity,
    delayFraction,
    progressAt,
    lerpTransform,
    STAGGER_MS,
    TOTAL_MS,
    FIT_MS,
  } from "../scatter/align.js";
  import {
    loadSettings,
    saveSettings,
    canGoLive,
    estimateMs,
    clampPanelWidth,
    PANEL_DEFAULT,
    PANEL_MIN,
    PANEL_MAX,
  } from "../mapSettings.js";

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
    /** `(params) => Promise<boolean>` — new coordinates, no run, no job (#327). */
    onpreview,
    /** How long the last projection took, in ms. Drives the live boundary. */
    lastMs = null,
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

  /**
   * The positions actually drawn, tweened from the previous layout (#327).
   *
   * `shown` is the truth; this is the truth on its way there. Two things have
   * to happen before a tween means anything:
   *
   *  1. **Align.** UMAP's rotation, reflection, scale and origin are arbitrary,
   *     so most of the apparent movement between two runs is meaningless. The
   *     new layout is fitted onto the old one first, leaving only real change
   *     to animate.
   *  2. **Pair by personId**, not by index. The member set can change between
   *     runs (a different minFaces), and animating index-to-index would send
   *     each dot to a stranger's position.
   *
   * A point with no previous position does not fly in from wherever index 7
   * used to be — it simply appears where it belongs.
   */
  let anim = $state(null);
  /** The aligned positions on screen when nothing is animating.
   *
   *  The animation runs towards the ALIGNED layout, so if the resting state
   *  fell back to raw coordinates the map would snap between two frames the
   *  instant the tween finished — which reads as it playing again. The aligned
   *  frame IS the display frame; raw coordinates are never drawn. */
  let settled = $state(null);
  let animRaf = 0;

  const drawn = $derived.by(() => {
    const n = shown.length;
    if (anim && anim.from.length === n * 2) {
      const out = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        // Each point runs its OWN clock: the stagger is what turns one mass
        // sliding into many separate things going many separate places.
        const t = progressAt(anim.elapsed, anim.delay[i]);
        out[i * 2] = anim.from[i * 2] + (anim.to[i * 2] - anim.from[i * 2]) * t;
        out[i * 2 + 1] =
          anim.from[i * 2 + 1] +
          (anim.to[i * 2 + 1] - anim.from[i * 2 + 1]) * t;
      }
      return out;
    }
    if (settled && settled.length === n * 2) return settled;
    const xy = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      xy[i * 2] = shown[i].x;
      xy[i * 2 + 1] = shown[i].y;
    }
    return xy;
  });

  /**
   * Play a layout change: re-frame, then move.
   *
   * The camera goes first and alone. Fitting at the END means the user watches
   * points travel to somewhere they cannot see and the map jumps afterwards;
   * fitting DURING means the ground moves while the things standing on it move
   * too, and nothing is readable. So: `FIT_MS` of camera, then the points.
   *
   * Imperative rAF driven from an `$effect`, with everything it writes read
   * back through `untrack` — an effect that reads and writes its own state
   * re-fires forever, which is CLAUDE.md's first trap wearing runes.
   */
  let lastKeyed = new Map();
  $effect(() => {
    const pts = shown;
    untrack(() => {
      const n = pts.length;
      const raw = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        raw[i * 2] = pts[i].x;
        raw[i * 2 + 1] = pts[i].y;
      }

      // Enough PAIRED points to measure an alignment from — not a share of
      // the new set. Changing the minimum faces can more than double the map
      // (76 people at 5, 258 at 2), and a "half the points must be familiar"
      // rule silently refused to animate exactly the change that moves most.
      // Newcomers do not need a previous position; they appear where they
      // belong.
      let known = 0;
      for (const p of pts) if (lastKeyed.has(p.personId)) known++;
      const worthTweening = n >= 2 && known >= 2 && !reduceMotion;

      cancelAnimationFrame(animRaf);

      if (!worthTweening) {
        anim = null;
        settled = raw;
        lastKeyed = new Map(pts.map((p) => [p.personId, [p.x, p.y]]));
        if (autoFit) requestAnimationFrame(() => scatter?.fit());
        return;
      }

      // Align onto where the map already is, so only real change animates
      // rather than an arbitrary spin and rescale. Measured on the PAIRED
      // points alone — including a newcomer with its own new position as its
      // "previous" one would bias the fit towards the identity transform.
      const pairPrev = new Float32Array(known * 2);
      const pairNext = new Float32Array(known * 2);
      let k = 0;
      for (let i = 0; i < n; i++) {
        const was = lastKeyed.get(pts[i].personId);
        if (!was) continue;
        pairPrev[k * 2] = was[0];
        pairPrev[k * 2 + 1] = was[1];
        pairNext[k * 2] = raw[i * 2];
        pairNext[k * 2 + 1] = raw[i * 2 + 1];
        k++;
      }
      const aligned = applySimilarity(raw, similarityFrom(pairPrev, pairNext));

      const from = new Float32Array(n * 2);
      const delay = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const was = lastKeyed.get(pts[i].personId);
        // A newcomer appears where it belongs rather than flying in from a
        // position that was never its own.
        from[i * 2] = was ? was[0] : aligned[i * 2];
        from[i * 2 + 1] = was ? was[1] : aligned[i * 2 + 1];
        delay[i] = delayFraction(i, n) * STAGGER_MS;
      }

      // Where the camera has to be for the NEW layout. Computed before
      // anything moves, so the re-frame can lead.
      let camFrom = null;
      let camTo = null;
      if (autoFit && scatter?.fitFor) {
        const xs = new Float32Array(n);
        const ys = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          xs[i] = aligned[i * 2];
          ys[i] = aligned[i * 2 + 1];
        }
        camTo = scatter.fitFor(xs, ys);
        camFrom = { ...transform };
      }

      const t0 = performance.now();
      const camMs = camTo ? FIT_MS : 0;
      anim = { from, to: aligned, delay, elapsed: 0 };

      const step = () => {
        const now = performance.now() - t0;
        if (camTo && now < camMs) {
          transform = lerpTransform(camFrom, camTo, now / camMs);
          anim = { ...anim, elapsed: 0 };
          animRaf = requestAnimationFrame(step);
          return;
        }
        if (camTo) transform = camTo;
        const e = now - camMs;
        anim = { ...anim, elapsed: e };
        if (e < TOTAL_MS) {
          animRaf = requestAnimationFrame(step);
          return;
        }
        // The map ENDS in the aligned frame, so that is what stays on screen
        // and what the next change starts from.
        settled = aligned;
        anim = null;
        lastKeyed = new Map(
          pts.map((p, i) => [p.personId, [aligned[i * 2], aligned[i * 2 + 1]]])
        );
      };
      animRaf = requestAnimationFrame(step);
    });
  });

  $effect(() => () => cancelAnimationFrame(animRaf));

  /** Respect the OS setting; an animation nobody asked for is worse than none. */
  const reduceMotion =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  const packed = $derived.by(() => {
    const n = shown.length;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const ids = new Int32Array(n);
    const size = new Float32Array(n);
    const group = new Uint8Array(n);
    const pos = drawn;
    for (let i = 0; i < n; i++) {
      const p = shown[i];
      x[i] = pos[i * 2];
      y[i] = pos[i * 2 + 1];
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
  let algo = $state("umap");

  /**
   * The run parameters the user is editing, keyed by parameter name.
   *
   * A bag rather than named fields, because the SCHEMA decides which
   * parameters exist for the chosen algorithm — hand-written fields shipped
   * with UMAP's two as the only controls, so t-SNE had nothing to tune.
   */
  let draft = $state({});

  /** The controls to render, from the server's schema for this algorithm. */
  const specs = $derived(options?.paramSpecs ?? []);

  /**
   * Seed each parameter from the server ONCE, then leave it alone.
   *
   * The previous version re-synced on every options refresh, and App refreshes
   * options with ITS params rather than the ones being typed — so editing a
   * value and touching anything else silently reverted it. A control that
   * appears to work and then undoes itself is worse than one that is disabled.
   *
   * Seeding still matters: it is how the gear starts from the server's clamped
   * defaults, so the gear and the cache key agree from the first render.
   */
  const seeded = new Set();
  const remembered = loadSettings();
  $effect(() => {
    const next = { ...draft };
    let changed = false;
    for (const spec of specs) {
      if (seeded.has(spec.key)) continue;
      seeded.add(spec.key);
      // Remembered value first (#287), then the server's default. The client
      // still states no opinion it does not HAVE — an untouched parameter has
      // nothing stored, so the server's default is what reaches the run.
      next[spec.key] =
        remembered[spec.key] ?? options?.params?.[spec.key] ?? spec.default;
      changed = true;
    }
    if (changed) draft = next;
  });

  // A display fallback for the instant before `paramSpecs` arrives — NOT a
  // second copy of the default. Nothing is sent to the server from it: the
  // client states no opinion it does not have (#307), so an unedited gear
  // sends no `minFaces` at all and the server fills in its own.
  const minFaces = $derived(draft.minFaces ?? 5);

  /** The schema row for the threshold, so it renders through the same control
   *  as everything else rather than being a hand-written second shape. */
  const minFacesSpec = $derived(
    specs.find((s) => s.key === "minFaces") ?? {
      key: "minFaces",
      label: "Minimum faces",
      min: 1,
      max: 50,
      step: 1,
      default: 5,
      help: "People with fewer faces than this are left off the map.",
    }
  );

  const currentParams = () => ({ ...draft, algorithm: algo });

  /**
   * A tuning control moved (#327).
   *
   * `live` means the slider is still being dragged. The map follows only when
   * the LAST projection was fast enough that following feels attached to the
   * control — measured, not assumed, so the same code is live on a 203-person
   * library and Apply-driven on a 25,758-person one.
   *
   * The debounce is a plain `let` timer driven from the handler, NOT a
   * reactive statement. CLAUDE.md's first trap: a `$:`/`$effect` whose
   * dependencies include an object re-fires on every flush forever.
   */
  /** Whether the sliders currently drive the map. Derived, so the hint and the
   *  handler can never disagree about which mode the panel is in. */
  const live = $derived(canGoLive(lastMs, options?.members) && !!onpreview);

  /** Panel width, dragged by the handle on its edge and remembered. */
  let panelWidth = $state(
    clampPanelWidth(loadSetting("faceMapPanelWidth", PANEL_DEFAULT))
  );
  $effect(() => saveSetting("faceMapPanelWidth", panelWidth));

  /**
   * Rebuild automatically on ANY setting, including the ones that normally
   * wait for Apply.
   *
   * Off by default and deliberately so: `minFaces` changes the member set, so
   * on a library too big to preview this turns every drag into a real job.
   * The label says that rather than leaving it to be discovered.
   */
  let autoApply = $state(loadSetting("faceMapAutoApply", false) === true);
  $effect(() => saveSetting("faceMapAutoApply", autoApply));

  /** Re-frame the map after every new layout. On by default. */
  let autoFit = $state(loadSetting("faceMapAutoFit", true) !== false);
  $effect(() => saveSetting("faceMapAutoFit", autoFit));

  let previewTimer = null;
  let applyTimer = null;

  /** Drag the panel's edge. Pointer events on the window, not the handle, so
   *  the drag survives the pointer leaving the 6px strip. */
  function startResize(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    const move = (ev) =>
      (panelWidth = clampPanelWidth(startW + (ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function onTune(key, value, { live: dragging }) {
    draft = { ...draft, [key]: value };
    saveSettings(draft);
    scheduleUpdate(key, dragging);
  }

  /**
   * Decide what a settings change should DO.
   *
   * Three routes, cheapest first:
   *  - preview, when the map can follow at this size and the parameter does
   *    not change who is on the map;
   *  - a real rebuild, when the user has asked for automatic updates — that
   *    is a JOB, so it is debounced hard and stays cancellable;
   *  - nothing, and Apply is there when they are ready.
   */
  /**
   * Which settings cannot be answered from the preview session.
   *
   * `minFaces` changes the member set the resident graph was built from, and
   * `algorithm` selects a different algorithm entirely — the preview path is
   * UMAP-only, since t-SNE is O(n^2) and PCA has nothing to tune. Both
   * therefore need a real rebuild, which is a job.
   */
  const NEEDS_REBUILD = new Set(["minFaces", "algorithm"]);

  function scheduleUpdate(key, dragging) {
    if (!NEEDS_REBUILD.has(key) && live && onpreview) {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => onpreview(currentParams()), 60);
      return;
    }
    // A setting that needs a rebuild applies BY ITSELF once you let go,
    // whether or not automatic updates are on. John: "changing the min num
    // faces still doesn't trigger the animation, I still have to hit
    // rebuild." Choosing a threshold or an algorithm is a decision; dragging
    // a slider is exploration, and only the latter waits for permission.
    if (!NEEDS_REBUILD.has(key) && (!autoApply || dragging)) return;
    if (dragging) return;
    clearTimeout(applyTimer);
    applyTimer = setTimeout(runWhenFree, 700);
  }

  /**
   * Start the rebuild, or wait for the one already running.
   *
   * The server single-flights projections and 409s a second one. Retrying is
   * better than surfacing "a map is already being built" to someone who simply
   * moved a slider twice — they did nothing wrong, and the message would be
   * about our plumbing rather than their photos.
   */
  function runWhenFree() {
    if (loading) {
      clearTimeout(applyTimer);
      applyTimer = setTimeout(runWhenFree, 300);
      return;
    }
    onrun?.(currentParams());
  }

  // A dragged slider outliving its view would fire a fetch into a dead
  // component. Svelte 5 runs an $effect's teardown on destroy.
  $effect(() => () => {
    clearTimeout(previewTimer);
    clearTimeout(applyTimer);
  });

  const algoRow = $derived(
    options?.algorithms?.find((a) => a.id === algo) ?? null
  );
  const algoLabel = $derived(algoRow?.label ?? "This projection");
  /** The algorithm's own knobs — `minFaces` has its own control above. */
  const tunables = $derived(specs.filter((s) => s.key !== "minFaces"));
  /**
   * How many people the threshold is leaving off the map (#255).
   *
   * `coverage.people` is every person with a face for this model; `members` is
   * the subset clearing `minFaces`. The default is 5, and on a real library
   * that hides the large majority — 20,259 of 25,758 persons are singletons.
   * A filter that quietly removes most of the data is the kind of thing that
   * later reads as data loss, so the number is stated rather than implied.
   */
  const hiddenByThreshold = $derived(
    Math.max(0, (coverage?.people ?? 0) - (options?.members ?? 0))
  );
  /** ~4s at 5,499 members, ~20s at 25,758 — measured, so the estimate is real. */
  const estimateSeconds = $derived(
    Math.max(2, Math.round(((options?.members ?? 0) / 5499) * 4))
  );

  function applyGear() {
    // The panel STAYS OPEN. Closing it on Apply meant every rebuild cost you
    // your place in the settings you were tuning — and tuning is the whole
    // point of the panel (#327).
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
    // NOT while the user is typing. `0` is this view's "fit the map back into
    // view" shortcut, and without this guard it ate every zero typed into the
    // panel's boxes: "0.0001" arrived as ".1". The bug shipped with #232 and
    // was unreachable until #327 put editable fields in the view — the same
    // shape as culling.spec.js's "typing digits in a text field does not
    // silently re-rate", which is why `isTypingTarget` already existed.
    if (isTypingTarget(e.target)) return;
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
  const crop = (p) => faceCropUrl(p?.coverFaceId);
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
             quietly pretends to be complete.

             A BUTTON, not a caption (#325). A map missing a third of the
             library, beside a line of amber text, reads as "this is broken"
             rather than "press this" — and the fix for it was one click away
             the whole time. `applyGear` is reused rather than given a second
             code path: it is already "clear the selection and run with the
             current parameters", which is exactly what this is, so the
             rebuild is the same job, in the JobsPanel, cancellable. -->
        <button
          class="warn stale"
          data-testid="map-stale"
          disabled={loading}
          onclick={applyGear}
        >
          {n(staleness.missing)} added since — rebuild to place them
        </button>
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

  <!-- The map and its settings side by side (#327). The settings used to be a
       popover OVER the map, so you could not see what a parameter did to the
       thing you were changing it for — and #326 established that the right
       neighbourhood cannot be predicted, only found by looking. The panel is
       first in the DOM and first visually, so tab order matches what you see. -->
  <div class="body">
    {#if gearOpen}
      <aside
        class="gear-panel"
        data-testid="map-gear-panel"
        style={`flex-basis:${panelWidth}px`}
      >
        <!-- minFaces is ALWAYS Apply-driven, at any library size: it changes the
           member set, so it invalidates both the centroid query and the
           preview session's neighbour graph. It is also the parameter where
           "how many people am I about to map" deserves a deliberate press. -->
        <ParamSlider
          spec={minFacesSpec}
          value={minFaces}
          onchange={(v) => {
            draft = { ...draft, minFaces: v };
            saveSettings(draft);
            // Refresh the member count shown beside the control...
            onoptions?.(currentParams());
            // ...and rebuild, which the threshold does by itself: it cannot be
            // previewed, so without this it silently did nothing until Rebuild
            // was pressed.
            scheduleUpdate("minFaces", false);
          }}
        />
        <span class="members" data-testid="map-members">
          {n(options?.members)} people · about {estimateSeconds}s
          {#if hiddenByThreshold > 0}
            <span class="hidden-count" data-testid="map-hidden">
              · {n(hiddenByThreshold)} with fewer faces left off
            </span>
          {/if}
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
                onchange={() => {
                  algo = a.id;
                  // Refetch so the panel below shows THIS algorithm's
                  // parameters; the schema is per-algorithm.
                  onoptions?.(currentParams());
                  // And route through the same scheduler as every other
                  // setting, so switching algorithm animates like the rest
                  // rather than sitting still until Apply is pressed.
                  scheduleUpdate("algorithm", false);
                }}
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
            square-root scale. These apply straight away — they do not rebuild
            the map.
          </p>
        </fieldset>

        <!-- Rendered from the algorithm's OWN schema, so choosing t-SNE offers
           perplexity rather than neighbours, and a new algorithm arrives with
           its controls instead of needing a third place hand-edited. -->
        <fieldset class="tuning" data-testid="map-tuning">
          <legend>{algoLabel} settings</legend>
          {#if tunables.length}
            {#each tunables as spec (spec.key)}
              <ParamSlider
                {spec}
                value={draft[spec.key] ?? spec.default}
                oninput={(v) => onTune(spec.key, v, { live: true })}
                onchange={(v) => onTune(spec.key, v, { live: false })}
              />
            {/each}
          {:else}
            <!-- An empty panel reads as a broken control; say why it is empty. -->
            <p class="hint" data-testid="map-no-params">
              {algoLabel} is a fixed projection — there is nothing to tune. It always
              produces the same map from the same photos.
            </p>
          {/if}
        </fieldset>

        <label class="auto">
          <input
            type="checkbox"
            data-testid="map-auto-fit"
            bind:checked={autoFit}
          />
          <span>
            Zoom to fit after each change
            <span class="auto-note">
              Off if you would rather stay where you have zoomed to.
            </span>
          </span>
        </label>

        <label class="auto">
          <input
            type="checkbox"
            data-testid="map-auto-apply"
            bind:checked={autoApply}
          />
          <span>
            Update automatically
            <span class="auto-note">
              rebuilds on every change, including Minimum faces. On a library
              too big to preview, each change starts a job.
            </span>
          </span>
        </label>

        <!-- Say WHICH mode the panel is in. Without this, a map that does not
             follow the slider reads as a broken control rather than as "this
             library is big enough that it needs a press" (#327). -->
        <p class="live-hint" data-testid="map-live-hint">
          {#if live}
            The map follows the sliders — about {Math.round(lastMs)}ms a change.
          {:else if lastMs != null}
            {Math.round(lastMs / 100) / 10}s a change, so the map waits for
            Apply.
          {:else}
            Build the map once and the sliders go live if it is quick enough.
          {/if}
        </p>

        <button
          class="primary"
          data-testid="map-build"
          onclick={applyGear}
          disabled={loading}
        >
          {loading ? "Building…" : runId ? "Rebuild map" : "Build map"}
        </button>
      </aside>
      <!-- Drag to resize. A separate element rather than a CSS `resize`,
           which cannot persist and cannot be clamped. -->
      <button
        type="button"
        class="resizer"
        data-testid="map-panel-resizer"
        aria-label="Resize the settings panel"
        aria-valuenow={panelWidth}
        aria-valuemin={PANEL_MIN}
        aria-valuemax={PANEL_MAX}
        onpointerdown={startResize}
        onkeydown={(e) => {
          if (e.key === "ArrowLeft")
            panelWidth = clampPanelWidth(panelWidth - 16);
          else if (e.key === "ArrowRight")
            panelWidth = clampPanelWidth(panelWidth + 16);
          else return;
          e.preventDefault();
        }}
      ></button>
    {/if}

    <div class="map-area">
      {#if !runId && !loading}
        <div class="empty" data-testid="map-empty">
          <p class="empty-title">No map yet.</p>
          <p class="empty-hint">
            A map lays out everyone by how alike their faces are, so you can
            lasso the groups that are really one person and merge them in one
            go.
            {#if options}
              {n(options.members)} people have {minFaces} or more faces — about {estimateSeconds}
              seconds.{#if hiddenByThreshold > 0}
                <span data-testid="map-hidden-empty">
                  {n(hiddenByThreshold)} more have fewer than {minFaces} and are left
                  off; lower the minimum in map settings to include them.
                </span>
              {/if}
            {/if}
          </p>
          <button
            class="primary"
            data-testid="map-build-empty"
            onclick={applyGear}
          >
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
              None of the {n(points.length)} people on the map appear in the photos
              you are viewing. Widen the filter, or clear it, to see everyone again.
            </p>
          </div>
        {/if}
        <div
          class="canvas-wrap"
          class:hidden={visibleSet && shown.length === 0}
        >
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
    </div>
  </div>

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
              data-person={p.personId}
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
  /* The staleness notice is a real control, so it has to LOOK like one — an
     outlined pill rather than text that happens to be clickable (#325). */
  .stale {
    font-family: inherit;
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 999px;
    padding: 2px 10px;
    cursor: pointer;
  }
  .stale:hover:not(:disabled) {
    background: rgba(255, 209, 102, 0.14);
  }
  .stale:disabled {
    cursor: default;
    opacity: 0.6;
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
  /* The map and its settings side by side (#327). `min-height: 0` on the row
     and `min-width: 0` on the map are what stop a flex child refusing to
     shrink below its content — without them the canvas pushes the panel off
     screen at narrow widths. */
  .body {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
  }
  .map-area {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }
  .resizer {
    flex: 0 0 6px;
    cursor: col-resize;
    background: #2a2a2a;
    border: 0;
    padding: 0;
    align-self: stretch;
  }
  .resizer:hover,
  .resizer:focus-visible {
    background: #7aa2f7;
  }
  .auto {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 0.8rem;
  }
  .auto input {
    margin-top: 2px;
  }
  .auto-note {
    display: block;
    font-size: 0.72rem;
    color: #888;
    line-height: 1.35;
  }
  .live-hint {
    margin: 0;
    font-size: 0.72rem;
    color: #888;
    line-height: 1.35;
  }
  .gear-panel > * {
    min-width: 0;
    max-width: 100%;
  }
  .gear-panel {
    background: #171717;
    border-right: 1px solid #2a2a2a;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: stretch;
    /* 10-20% of the view, with pixel bounds so it stays usable on a laptop
       and does not become a canyon on an ultrawide. */
    /* Width is the user's, dragged by the handle and remembered; the
       flex-basis comes from `panelWidth` inline. */
    flex: 0 0 auto;
    width: auto;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .gear-panel label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 0.8rem;
    color: #bbb;
  }
  /* Was `min-width: 20rem`, from when this was a wide horizontal popover. In a
     16% column that forces the sliders off the edge — caught by looking at a
     screenshot, not by any test (#327). */
  .sizes {
    min-width: 0;
  }
  .tuning {
    min-width: 22rem;
    max-width: 30rem;
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
  /* Dimmer than the count it qualifies: it is a caveat, not a headline. */
  .hidden-count {
    color: #6f6f6f;
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
  /* One column, not three. `auto auto 1fr` fitted a wide popover; in a narrow
     panel the measured note ("Finds the same person in the top 5 about 58% of
     the time") was clipped mid-sentence — which is worse than absent, because
     it looks like the app is broken rather than terse. */
  .algo {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 6px;
    align-items: baseline;
    font-size: 0.8rem;
  }
  .algo-note {
    grid-column: 1 / -1;
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
