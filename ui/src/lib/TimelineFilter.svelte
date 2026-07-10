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
  import { scaleTime, timeFormat, curveBasis } from "d3";
  import { zoomableAxisInput } from "@john-guerra/d3-zoomable-axis";

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
          type: "area", // one-sided sparkline fill (spec'd), not a mirrored violin
          style: "kde",
          size: 30,
          curve: curveBasis, // smooth sparkline; swap for any d3 curve factory
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
          np.times !== last.times;
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
  <div class="timeline-axis" use:timeline={{ min, max, times, value, width }}>
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
</div>

<style>
  .timeline {
    width: 100%;
    padding: 2px 4px 0;
    box-sizing: border-box;
    overflow: visible;
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
