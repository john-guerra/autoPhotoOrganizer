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
  import { scaleTime, timeFormat } from "d3";
  import { zoomableAxisInput } from "@john-guerra/d3-zoomable-axis/input";

  // Density (KDE/scent) look. The widget owns the live settings popover + its
  // persistence now (scent.controls + scent.persistKey), so these are just the
  // initial defaults; the user's tuned values are restored from localStorage by
  // the widget itself.
  const KDE_PERSIST_KEY = "autogallery.timelineKde";
  const DEFAULT_KDE = {
    type: "area", // area | violin | histogram
    curve: "monotoneX", // honest interpolation: passes through the density points
    adjust: 0.5, // smoothing: multiplier on the auto Scott bandwidth. Photo
    // times are spiky/multimodal (bursts separated by gaps), so the global
    // Scott bandwidth over-smooths the very gaps this timeline exists to show;
    // halving it keeps event/gap structure legible for album boundaries.
    pad: 0, // fast-kde domain padding (fraction)
    bins: 60, // evaluation points — raised so the narrower kernel resolves
    // detail instead of aliasing into a jagged comb
    size: 30, // scent height (px)
  };

  export let min = null; // epoch ms, domain start (null = no data)
  export let max = null; // epoch ms, domain end
  export let times = []; // sampled timestamps (ms) for the KDE
  export let value = null; // [fromMs|null, toMs|null] current brush, or null
  export let viewTime = null; // epoch ms of the first photo on screen ("current view")
  export let focusTime = null; // epoch ms of the focused/selected photo ("focused photo")

  const dispatch = createEventDispatcher();
  const AXIS_MARGIN = 22; // zoomableAxisInput's default side margin (px each side)
  const fmt = timeFormat("%b %e, %Y");

  let width = 0; // measured via bind:clientWidth (SnapshotStrip lesson)

  // Map a data-space time to the axis pixel x. Uses the same geometry the widget
  // mounts with (AXIS_MARGIN + length), so markers line up with the axis by
  // construction. The axis is always full-domain (the brush is an overlay band, not
  // a re-zoom), so this mapping is stable.
  function pxForTime(t) {
    if (t == null || min == null || max == null || max <= min || !(width > 0))
      return null;
    return (
      AXIS_MARGIN +
      Math.max(0, Math.min(1, (t - min) / (max - min))) *
        Math.max(60, width - AXIS_MARGIN * 2)
    );
  }
  $: viewPx = pxForTime(viewTime);
  $: focusPx = pxForTime(focusTime);

  // When the focused photo IS the top of the viewport the two anchors sit on top of
  // each other; collapse to just the amber focus marker so the caps don't overlap
  // into mush. As you scroll away, `viewPx` diverges and the eye marker reappears —
  // which is exactly the "two markers" the split is for.
  // TUNABLE: the coincidence threshold (px) and which marker wins on overlap.
  $: markersCoincide =
    viewPx != null && focusPx != null && Math.abs(viewPx - focusPx) < 7;
  $: showViewMarker = viewPx != null && !markersCoincide;
  $: showFocusMarker = focusPx != null;

  // Tooltips carry the anchor's date so hovering a marker says both what it is and
  // when it points to.
  $: viewLabel =
    viewTime == null
      ? "Current view"
      : `Current view — ${fmt(new Date(viewTime))}`;
  $: focusLabel =
    focusTime == null
      ? "Focused photo"
      : `Focused photo — ${fmt(new Date(focusTime))}`;

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
        const covered =
          lo - last.min <= span * 0.004 && last.max - hi <= span * 0.004;
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
      if (
        !(np.width > 0) ||
        np.min == null ||
        np.max == null ||
        np.min >= np.max
      )
        return;
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
          // Initial look; the widget's ⚙ panel live-tunes these and remembers
          // them in localStorage (persistKey), restoring across rebuilds/sessions.
          ...DEFAULT_KDE,
          style: DEFAULT_KDE.type === "histogram" ? "bars" : "kde",
          side: "in", // rise toward the plot (up), matching the area sparkline
          color: "#3a3a3a",
          colorSelected: "#4c9aff",
          // controls default ON — the widget's density gear + popover
          persistKey: KDE_PERSIST_KEY,
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
  <!-- The density settings ⚙ gear + popover now live inside the widget itself
       (scent.controls), which also persists the tuned params (scent.persistKey). -->
  <div class="timeline-axis" use:timeline={{ min, max, times, value, width }}>
    {#if showViewMarker}
      <div class="marker view-marker" style="left:{viewPx}px" title={viewLabel}>
        <span class="cap eye-cap">
          <svg viewBox="0 0 12 9" width="12" height="9" aria-hidden="true">
            <path
              d="M1 4.5C3 1 9 1 11 4.5 9 8 3 8 1 4.5Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
            />
            <circle cx="6" cy="4.5" r="1.7" fill="currentColor" />
          </svg>
        </span>
      </div>
    {/if}
    {#if showFocusMarker}
      <div
        class="marker focus-marker"
        style="left:{focusPx}px"
        title={focusLabel}
      >
        <span class="cap tri-cap" aria-hidden="true"></span>
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
    position: relative;
  }
  .timeline-axis {
    position: relative;
    min-height: 60px;
  }
  /* The widget draws its own SVG axis + handles; give its accent a home. A muted
     slate-blue (same ~213° hue as the app's #4c9aff action-azure, but low chroma)
     keeps the whole range widget — pill, band, handles — calm and recessive
     rather than a focal point. */
  .timeline-axis :global(.zoomable-axis-input) {
    --za-accent: #5f83ad;
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
  /* Two read-only "you are here" ticks over the density band, distinct from the
     blue brush. The FOCUS tick (amber) marks the photo you're working on; the VIEW
     tick (cool grey, eye cap) marks the top of what's on screen and moves as you
     scroll. Short ticks span just the band down to the axis line (thickness 30 →
     axis at ~37px), so they mark the spot without adding toolbar height. The line
     never intercepts clicks (handles/brush stay usable underneath); only the small
     cap above the band is hoverable, so its `title` tooltip is reachable. */
  .marker {
    position: absolute;
    top: 7px;
    height: 30px;
    width: 2px;
    transform: translateX(-1px);
    pointer-events: none;
    transition: left 90ms linear;
  }
  .view-marker {
    background: #b9c2cc;
    z-index: 5;
  }
  .focus-marker {
    background: #ffd24c;
    z-index: 6; /* the working photo wins if the two ticks are near each other */
  }
  .cap {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    line-height: 0;
    pointer-events: auto; /* hoverable so the tooltip shows, without blocking the band */
  }
  .eye-cap {
    top: -11px;
    color: #b9c2cc;
  }
  .tri-cap {
    top: -4px;
    width: 0;
    height: 0;
    border-left: 3px solid transparent;
    border-right: 3px solid transparent;
    border-top: 4px solid #ffd24c;
  }
</style>
