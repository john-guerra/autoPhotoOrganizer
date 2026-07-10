<script>
  /**
   * Brushable density timeline — a new time-range facet of the shared filter.
   * Wraps @john-guerra/d3-zoomable-axis's `zoomableAxisInput`: a d3 time axis
   * with dual drag-to-zoom handles that draws a "scented" KDE of the photo
   * timestamps and emits the selected [lo,hi] in data space. We forward that as
   * `range` (or `clear` when the brush covers the whole span). Presentational —
   * App owns filter.dateFrom/dateTo; this only renders + emits.
   *
   * Mounted via a Svelte action (the same DOM-widget pattern as the group-by
   * MultiAutoSelect). Rebuilds when the domain/density/width changes; a bare
   * `value` change (e.g. a programmatic clear) is pushed to the widget silently
   * so it never loops back through `input`.
   */
  import { createEventDispatcher } from "svelte";
  import {
    scaleTime,
    timeFormat,
    curveBasis,
    curveNatural,
    curveMonotoneX,
    curveCatmullRom,
    curveLinear,
    curveStep,
  } from "d3";
  import { zoomableAxisInput } from "@john-guerra/d3-zoomable-axis";

  // d3 curve factories the density panel offers, by key.
  const CURVES = {
    basis: curveBasis,
    natural: curveNatural,
    monotone: curveMonotoneX,
    catmullRom: curveCatmullRom,
    linear: curveLinear,
    step: curveStep,
  };
  const CURVE_LABELS = {
    basis: "Basis",
    natural: "Natural",
    monotone: "Monotone",
    catmullRom: "Catmull-Rom",
    linear: "Linear",
    step: "Step",
  };
  const DAY_MS = 86400000;

  // Tunable density (KDE/scent) params, persisted so the user's chosen look
  // sticks. bandwidthDays 0 = automatic (fast-kde's Scott rule).
  const LS_KDE = "autogallery.timelineKde";
  const DEFAULT_KDE = {
    type: "area", // area | violin | histogram
    curve: "basis",
    bandwidthDays: 0, // 0 → auto
    bins: 30,
    size: 30,
  };
  let kde = (() => {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KDE) ?? "null");
      if (s && typeof s === "object") return { ...DEFAULT_KDE, ...s };
    } catch {
      /* fall through */
    }
    return { ...DEFAULT_KDE };
  })();
  $: localStorage.setItem(LS_KDE, JSON.stringify(kde));
  let settingsOpen = false;
  // Reassign to a NEW object on every change so the mount action sees a fresh
  // reference and rebuilds the widget (mutating in place wouldn't trigger it).
  const setKde = (patch) => (kde = { ...kde, ...patch });

  export let min = null; // epoch ms, domain start (null = no data)
  export let max = null; // epoch ms, domain end
  export let times = []; // sampled timestamps (ms) for the KDE
  export let value = null; // [fromMs|null, toMs|null] current brush, or null
  export let currentTime = null; // epoch ms of the first photo in view ("you are here")

  const dispatch = createEventDispatcher();
  const AXIS_MARGIN = 22; // zoomableAxisInput's default side margin (px each side)
  const fmt = timeFormat("%b %e, %Y");

  let width = 0; // measured via bind:clientWidth (SnapshotStrip lesson)

  // "You are here": pixel x of the current photo's time along the axis. Uses the
  // same geometry the widget mounts with (AXIS_MARGIN + length), so the marker
  // lines up with the axis by construction. The axis is always full-domain (the
  // brush is an overlay band, not a re-zoom), so this mapping is stable.
  $: markerPx =
    currentTime == null || min == null || max == null || max <= min || !(width > 0)
      ? null
      : AXIS_MARGIN +
        Math.max(0, Math.min(1, (currentTime - min) / (max - min))) *
          Math.max(60, width - AXIS_MARGIN * 2);

  // Resolve the brush endpoints from `value`, filling open bounds with the
  // domain edges. A null/empty value means "no time filter" → full span.
  function brushRange(v, lo, hi) {
    if (!v || (v[0] == null && v[1] == null)) return [lo, hi];
    return [v[0] == null ? lo : v[0], v[1] == null ? hi : v[1]];
  }

  function timeline(node, p) {
    let widget = null;
    let last = {};
    let timer = null;

    const emit = () => {
      const [lo, hi] = widget.value.map(Number);
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Brush spanning (nearly) the whole domain = no constraint → clear.
        const span = last.max - last.min || 1;
        const covered = lo - last.min <= span * 0.004 && last.max - hi <= span * 0.004;
        if (covered) dispatch("clear");
        else dispatch("range", [Math.round(lo), Math.round(hi)]);
      }, 120);
    };

    function build(np) {
      if (widget) {
        widget.removeEventListener("input", emit);
        widget.remove();
        widget = null;
      }
      last = np;
      if (!(np.width > 0) || np.min == null || np.max == null || np.min >= np.max) return;
      const length = Math.max(60, np.width - AXIS_MARGIN * 2);
      const scale = scaleTime().domain([new Date(np.min), new Date(np.max)]);
      const k = np.kde || DEFAULT_KDE;
      widget = zoomableAxisInput(scale, {
        orient: "bottom",
        length,
        thickness: 30, // compact band height so the toolbar row stays short
        // Continuous: a time-range filter shouldn't snap endpoints to a grid.
        step: 0,
        // Sparse ticks so year labels don't crowd in the compact toolbar width.
        ticks: 4,
        // Double-click a badge → native datetime picker (down to the second).
        inputType: "datetime-local",
        value: brushRange(np.value, np.min, np.max),
        format: (d) => fmt(new Date(+d)),
        scent: {
          values: np.times || [],
          type: k.type, // area (sparkline) | violin | histogram — user-tunable
          style: k.type === "histogram" ? "bars" : "kde",
          size: k.size,
          bins: k.bins,
          // bandwidthDays 0 → omit so fast-kde uses its automatic (Scott) rule.
          ...(k.bandwidthDays > 0 ? { bandwidth: k.bandwidthDays * DAY_MS } : {}),
          curve: CURVES[k.curve] || curveBasis,
          color: "#3a3a3a",
          colorSelected: "#4c9aff",
        },
      });
      widget.addEventListener("input", emit);
      node.appendChild(widget);
    }

    build(p);
    return {
      update(np) {
        const rebuilt =
          np.min !== last.min ||
          np.max !== last.max ||
          np.width !== last.width ||
          np.times !== last.times ||
          np.kde !== last.kde; // density params changed → rebuild the scent
        if (rebuilt) {
          build(np);
          return;
        }
        // Only the brush value changed (e.g. a clear from the ✕ button): sync it
        // into the widget silently — the reactive-widget setter doesn't emit.
        const nv = brushRange(np.value, np.min, np.max);
        const cur = widget ? widget.value.map(Number) : null;
        if (widget && cur && (nv[0] !== cur[0] || nv[1] !== cur[1])) {
          widget.value = nv;
        }
        last = np;
      },
      destroy() {
        clearTimeout(timer);
        if (widget) {
          widget.removeEventListener("input", emit);
          widget.remove();
        }
      },
    };
  }
</script>

<div class="timeline" bind:clientWidth={width}>
  <button
    class="kde-gear"
    class:on={settingsOpen}
    title="Density (KDE) settings"
    aria-label="Density settings"
    aria-expanded={settingsOpen}
    on:click={() => (settingsOpen = !settingsOpen)}
  >
    ⚙
  </button>
  <div class="timeline-axis" use:timeline={{ min, max, times, value, width, kde }}>
    {#if markerPx != null}
      <div
        class="you-are-here"
        style="left:{markerPx}px"
        title="Current view"
        aria-hidden="true"
      >
        <span class="yah-cap"></span>
      </div>
    {/if}
  </div>

  {#if settingsOpen}
    <div class="kde-panel" role="dialog" aria-label="Timeline density settings">
      <div class="kde-row">
        <label for="kde-type">Shape</label>
        <select
          id="kde-type"
          value={kde.type}
          on:change={(e) => setKde({ type: e.target.value })}
        >
          <option value="area">Area (sparkline)</option>
          <option value="violin">Violin</option>
          <option value="histogram">Histogram</option>
        </select>
      </div>
      <div class="kde-row" class:disabled={kde.type === "histogram"}>
        <label for="kde-curve">Curve</label>
        <select
          id="kde-curve"
          value={kde.curve}
          disabled={kde.type === "histogram"}
          on:change={(e) => setKde({ curve: e.target.value })}
        >
          {#each Object.keys(CURVES) as c}
            <option value={c}>{CURVE_LABELS[c]}</option>
          {/each}
        </select>
      </div>
      <div class="kde-row" class:disabled={kde.type === "histogram"}>
        <label for="kde-bw">Smoothing</label>
        <input
          id="kde-bw"
          type="range"
          min="0"
          max="180"
          step="1"
          value={kde.bandwidthDays}
          disabled={kde.type === "histogram"}
          on:input={(e) => setKde({ bandwidthDays: +e.target.value })}
        />
        <span class="kde-val">{kde.bandwidthDays === 0 ? "auto" : kde.bandwidthDays + "d"}</span>
      </div>
      <div class="kde-row">
        <label for="kde-bins">Bins</label>
        <input
          id="kde-bins"
          type="range"
          min="10"
          max="120"
          step="1"
          value={kde.bins}
          on:input={(e) => setKde({ bins: +e.target.value })}
        />
        <span class="kde-val">{kde.bins}</span>
      </div>
      <div class="kde-row">
        <label for="kde-size">Height</label>
        <input
          id="kde-size"
          type="range"
          min="12"
          max="48"
          step="1"
          value={kde.size}
          on:input={(e) => setKde({ size: +e.target.value })}
        />
        <span class="kde-val">{kde.size}px</span>
      </div>
      <div class="kde-actions">
        <button class="kde-reset" on:click={() => (kde = { ...DEFAULT_KDE })}>Reset</button>
        <button class="kde-done" on:click={() => (settingsOpen = false)}>Done</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .timeline {
    width: 100%;
    padding: 2px 4px 0;
    box-sizing: border-box;
    overflow: visible;
    position: relative;
  }
  /* Density settings gear + popover. */
  .kde-gear {
    position: absolute;
    top: -2px;
    right: 2px;
    z-index: 6;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: #6f6f6f;
    font-size: 12px;
    line-height: 18px;
    cursor: pointer;
  }
  .kde-gear:hover,
  .kde-gear.on {
    color: #d8d8d8;
    background: #2c2c2c;
  }
  .kde-panel {
    position: absolute;
    top: 18px;
    right: 0;
    z-index: 30;
    width: 224px;
    box-sizing: border-box;
    background: #1e1e1e;
    border: 1px solid #383838;
    border-radius: 8px;
    padding: 10px;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .kde-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.72rem;
  }
  .kde-row.disabled {
    opacity: 0.4;
  }
  .kde-row label {
    width: 58px;
    flex-shrink: 0;
    color: #9a9a9a;
  }
  .kde-row select {
    flex: 1;
    min-width: 0;
    background: #101010;
    border: 1px solid #333;
    color: #cfcfcf;
    border-radius: 4px;
    padding: 2px 4px;
    font-size: 0.72rem;
  }
  .kde-row input[type="range"] {
    flex: 1;
    min-width: 0;
    accent-color: #4c9aff;
  }
  .kde-val {
    width: 36px;
    flex-shrink: 0;
    text-align: right;
    color: #9a9a9a;
    font-variant-numeric: tabular-nums;
  }
  .kde-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 2px;
  }
  .kde-actions button {
    border: 1px solid #444;
    background: transparent;
    color: #cfcfcf;
    border-radius: 5px;
    padding: 3px 12px;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .kde-done {
    background: #4c9aff;
    color: #06121f;
    border-color: #4c9aff;
    font-weight: 600;
  }
  .timeline-axis {
    position: relative;
    min-height: 60px;
  }
  /* The widget draws its own SVG axis + handles; give its accent a home so the
     selected KDE band matches the app's blue. */
  .timeline-axis :global(.zoomable-axis-input) {
    --za-accent: #4c9aff;
    color: #9a9a9a;
  }
  /* Compact the date pills so a narrow selection (both handles clustered) crowds
     less. Higher specificity than the widget's own `.zoomable-axis-input
     .za-value` rule (3 classes vs 2) so this wins despite loading first. */
  .timeline-axis :global(.zoomable-axis-input .za-value) {
    font-size: 0.62rem;
    padding: 1px 6px;
    letter-spacing: -0.2px;
  }
  /* "You are here": a thin amber marker at the current view's time — read-only,
     distinct from the blue brush band. Sits above the axis; never intercepts
     clicks so the handles/brush stay usable underneath it. */
  /* Short amber tick spanning just the density band down to the axis line
     (thickness 30 → axis at ~37px), so it marks the spot without adding height. */
  .you-are-here {
    position: absolute;
    top: 7px;
    height: 30px;
    width: 2px;
    background: #ffd24c;
    transform: translateX(-1px);
    pointer-events: none;
    z-index: 5;
    transition: left 90ms linear;
  }
  .yah-cap {
    position: absolute;
    top: -4px;
    left: 50%;
    transform: translateX(-50%);
    border-left: 3px solid transparent;
    border-right: 3px solid transparent;
    border-top: 4px solid #ffd24c;
  }
</style>
