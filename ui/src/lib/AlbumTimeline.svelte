<script>
  /**
   * The album timeline: the time range analyzed, and where the break points fall.
   *
   * Four layers over ONE x-scale — album bands (svg), a dot per photo (canvas),
   * the KDE density + time axis (@john-guerra/d3-zoomable-axis), and the
   * "you are here" marker. The gaps BETWEEN the bands are the break points; they
   * are drawn as literal empty space, because that is what a gap is.
   *
   * Rebuilt from legacy/2024-electron-standalone/photoTimelineChart.js.
   *
   * ZOOM. `zoomableAxisInput` is a range selector over its scale: the handles
   * emit [lo,hi] and the CONSUMER's chart zooms (see its README). So the widget's
   * scale IS our view — zooming rebuilds it with the new domain, and the ticks,
   * the density, the bands and the dots all derive from that one scale and line
   * up by construction. Zoom the layers while leaving the axis full-domain and
   * the dots drift off the ticks, which is the exact bug the widget exists to
   * prevent.
   *
   * NOT TimelineFilter. That component emits a range that MEANS FILTER; here the
   * identical gesture means ZOOM. Same widget, different meaning — one component
   * serving both would need a mode flag, and mode flags are how a component grows
   * a second personality.
   */
  import { scaleTime, timeFormat } from "d3";
  import { zoomableAxisInput } from "@john-guerra/d3-zoomable-axis/input";
  import { albumColor } from "./albumColors.js";
  import { analyzedDomain, albumOfPhotos, hitAt } from "./albumTimeline.js";
  import { thumbUrl } from "./api.js";

  let {
    photos = [], // [{id,t}] ascending by t — the clustered working set
    albums = [], // [{index,startAt,endAt,ids}] from clusterByGap
    names = [], // the album folder names, for the tooltip
    hoveredIndex = -1, // album highlighted from the list below
    viewportIndex = -1, // album at the top of the scrolled list
    onhover, // (album) => void — hover crosses a band/dot; -1 in a real gap
    onselect, // (album) => void — click selects an album; scrolls the list
  } = $props();

  // Truncation (the working set was capped) is stated by AlbumsView's existing
  // warning, which sits directly above this strip and already carries the
  // actionable half ("raise Max…"). Repeating it here would be two boxes saying
  // one thing; AlbumsView adds the cutoff DATE to that message instead, which is
  // the part this chart is responsible for making honest.

  const AXIS_MARGIN = 22; // zoomableAxisInput's side margin (matches TimelineFilter)
  const BAND_H = 10; // album bands
  const DOTS_H = 16; // the photo dots
  const AXIS_H = 26; // the widget's scent band
  const fmtDay = timeFormat("%b %e, %Y");
  const fmtStamp = timeFormat("%b %e, %Y · %H:%M");

  const KDE_PERSIST_KEY = "autogallery.albumTimelineKde";
  const DEFAULT_KDE = {
    type: "area",
    curve: "monotoneX",
    // Photo times are spiky and multimodal — bursts separated by the very gaps
    // this chart exists to show. The global Scott bandwidth smooths them away, so
    // halve it (the same reasoning, and the same value, as TimelineFilter).
    adjust: 0.5,
    pad: 0,
    bins: 60,
    size: AXIS_H,
  };

  let width = $state(0);
  let canvas = $state(null);
  let hoverPx = $state(null); // cursor x within the strip, or null
  let tip = $state(null); // {x, id, t, albumIndex} | null

  // The full range that was actually clustered. The chart can be zoomed into a
  // sub-range, but this is what "reset" returns to and what the notice describes.
  const full = $derived(analyzedDomain(photos));
  const times = $derived(photos.map((p) => p.t));

  // The current view. Starts as the analyzed range; the axis handles zoom it.
  let view = $state(null);
  let zoomed = $state(false);
  $effect(() => {
    // Seed/reset the view to the full range whenever we're NOT zoomed. This must
    // not READ `view`: an $effect that both reads and writes `view` re-fires on
    // its own write (each assignment re-proxies the array to a fresh reference),
    // which is the effect_update_depth_exceeded loop. The old `view == null` init
    // case is already covered — on mount `zoomed` is false, so this seeds it.
    if (full && !zoomed) view = full;
  });
  $effect(() => {
    if (!full) {
      view = null;
      zoomed = false;
    }
  });

  // A zero-width span is a real case (a folder of scans all sharing one mtime).
  // There is no timeline to draw for a single instant, and inventing a range
  // would be a lie about the data.
  const hasSpan = $derived(view != null && view[1] > view[0]);

  const length = $derived(Math.max(60, width - AXIS_MARGIN * 2));
  // Plain functions, not $derived: they're read at CALL time (in onMove/onClick/
  // drawDots), always closing over the current hasSpan/view/length — no
  // memoization benefit, and `$derived` would need to be forced to re-read those
  // values on every recompute since a function literal's body isn't executed
  // (and therefore doesn't register as a dependency) until it's later invoked.
  function pxOf(t) {
    return !hasSpan
      ? null
      : AXIS_MARGIN + ((t - view[0]) / (view[1] - view[0])) * length;
  }
  function timeAt(px) {
    return !hasSpan
      ? null
      : view[0] + ((px - AXIS_MARGIN) / length) * (view[1] - view[0]);
  }

  // Every photo's album — drives the dot colours and the click target.
  const albumOfPhoto = $derived(albumOfPhotos(photos, albums));

  // --- the dots (canvas) ----------------------------------------------------
  // 20,000 photos is the DEFAULT working set here. That many <circle> elements,
  // re-created every time the k slider moves, would jank — and the slider is the
  // one control that has to feel instant, because it IS the tuning. A canvas
  // redraws the lot in about a millisecond.
  $effect(() => {
    if (canvas && width > 0) drawDots(photos, albumOfPhoto, view, hoveredIndex);
  });

  function drawDots(ps, ofAlbum, v, hov) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(DOTS_H * dpr));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, DOTS_H);
    if (!hasSpan || !ps.length) return;

    const y = DOTS_H / 2;
    for (let i = 0; i < ps.length; i++) {
      const x = pxOf(ps[i].t);
      if (x == null || x < 0 || x > width) continue; // clipped by the zoom
      const ai = ofAlbum[i];
      ctx.globalAlpha = hov < 0 || hov === ai ? 0.95 : 0.25;
      ctx.fillStyle = ai < 0 ? "#666" : albumColor(ai);
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // --- pointer --------------------------------------------------------------

  // The hit test itself lives in albumTimeline.js (pure, tested). It is the one
  // place that decides what the cursor means, so hover and click cannot disagree.
  function hit(px) {
    return hitAt({ px, times, albums, albumOfPhoto, xOf: pxOf, timeAt });
  }

  function onMove(e) {
    if (!hasSpan) return;
    const rect = e.currentTarget.getBoundingClientRect();
    hoverPx = e.clientX - rect.left;

    const { album, photo } = hit(hoverPx);
    onhover?.(album); // -1 in a real gap: the list clears its highlight
    tip =
      photo >= 0 ? { x: hoverPx, id: photos[photo].id, t: times[photo] } : null; // no photo near the cursor ⇒ no thumbnail claiming one is there
  }

  function onLeave() {
    hoverPx = null;
    tip = null;
    onhover?.(-1);
  }

  function onClick() {
    if (!hasSpan || hoverPx == null) return;
    const { album } = hit(hoverPx);
    if (album >= 0) onselect?.(album); // scroll the list to this album
  }

  function resetZoom() {
    if (!full) return;
    view = full;
    zoomed = false;
  }

  // --- the axis widget ------------------------------------------------------

  function axis(node, p) {
    let widget = null;
    let last = {};

    const onInput = () => {
      const [lo, hi] = widget.value.map(Number);
      if (!(hi > lo)) return;
      // The handles select a sub-range; that IS the zoom. Rebuilding the widget
      // with this domain (below, via `update`) rescales the ticks and the density
      // with it, so every layer keeps sharing one scale.
      view = [lo, hi];
      zoomed = true;
    };

    function build(np) {
      if (widget) {
        widget.removeEventListener("input", onInput);
        widget.remove();
        widget = null;
      }
      last = np;
      if (!(np.length > 0) || !np.view || !(np.view[1] > np.view[0])) return;

      const scale = scaleTime().domain([
        new Date(np.view[0]),
        new Date(np.view[1]),
      ]);
      widget = zoomableAxisInput(scale, {
        orient: "bottom",
        length: np.length,
        thickness: AXIS_H,
        step: 0, // continuous: photo times don't live on a grid
        ticks: 4,
        inputType: "datetime-local",
        value: [np.view[0], np.view[1]], // handles open: the whole current view
        format: (d) => fmtDay(new Date(+d)),
        scent: {
          values: np.times || [],
          ...DEFAULT_KDE,
          style: "kde",
          side: "in",
          color: "#3a3a3a",
          colorSelected: "#4c9aff",
          persistKey: KDE_PERSIST_KEY,
        },
      });
      widget.addEventListener("input", onInput);
      node.appendChild(widget);
    }

    build(p);
    return {
      update(np) {
        // Rebuild only when the SCALE changes — a zoom, a resize, or new photos.
        // The widget owns its own handle state in between.
        const changed =
          np.length !== last.length ||
          np.times !== last.times ||
          np.view?.[0] !== last.view?.[0] ||
          np.view?.[1] !== last.view?.[1];
        if (changed) build(np);
      },
      destroy() {
        if (widget) {
          widget.removeEventListener("input", onInput);
          widget.remove();
        }
      },
    };
  }
</script>

<div class="album-timeline" bind:clientWidth={width}>
  {#if !photos.length}
    <p class="tl-empty">No photos to cluster.</p>
  {:else if !hasSpan}
    <p class="tl-empty">
      All {photos.length.toLocaleString()} photos share one timestamp ({fmtStamp(
        new Date(full[0])
      )}) — there is no time span to draw, so they form a single album.
    </p>
  {:else}
    <!-- The plot is a pointer-only convenience: clicking a band scrolls the list
         to that album, and every album it can reach is already keyboard-reachable
         by tabbing the name fields below. So there is no keyboard handler here to
         write — a fake one on a canvas would be worse than none. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="tl-plot"
      onpointermove={onMove}
      onpointerleave={onLeave}
      onclick={onClick}
      ondblclick={resetZoom}
      style="height:{BAND_H + DOTS_H}px"
    >
      <svg class="tl-bands" {width} height={BAND_H + DOTS_H}>
        {#each albums as album, i (album.index)}
          {@const x0 = pxOf(album.startAt)}
          {@const x1 = pxOf(album.endAt)}
          {#if x1 >= 0 && x0 <= width}
            <rect
              class="band"
              class:dim={hoveredIndex >= 0 && hoveredIndex !== i}
              class:on={hoveredIndex === i}
              x={Math.max(0, x0)}
              y="0"
              width={Math.max(1.5, Math.min(width, x1) - Math.max(0, x0))}
              height={BAND_H}
              fill={albumColor(i)}
              rx="1.5"
            >
              <title
                >{names[i] || `Album ${i + 1}`} — {album.ids.length} photo{album
                  .ids.length === 1
                  ? ""
                  : "s"}</title
              >
            </rect>
          {/if}
        {/each}

        {#if viewportIndex >= 0 && albums[viewportIndex]}
          {@const mx = pxOf(albums[viewportIndex].startAt)}
          {#if mx >= 0 && mx <= width}
            <polygon
              class="here"
              points="{mx - 4},{BAND_H + DOTS_H} {mx + 4},{BAND_H +
                DOTS_H} {mx},{BAND_H + DOTS_H - 6}"
            >
              <title>You are here</title>
            </polygon>
          {/if}
        {/if}
      </svg>

      <canvas
        class="tl-dots"
        bind:this={canvas}
        style="width:{width}px;height:{DOTS_H}px;top:{BAND_H}px"
      ></canvas>

      {#if tip}
        <div
          class="tl-tip"
          style="left:{Math.max(0, Math.min(width - 108, tip.x - 54))}px"
        >
          <img src={thumbUrl(tip.id, 96)} alt="" width="96" height="96" />
          <span>{fmtStamp(new Date(tip.t))}</span>
        </div>
      {/if}
    </div>

    <div class="tl-axis" use:axis={{ length, view, times }}></div>

    {#if zoomed}
      <button
        class="tl-reset"
        onclick={resetZoom}
        title="Double-click the chart">⤢ Reset zoom</button
      >
    {/if}
  {/if}
</div>

<style>
  .album-timeline {
    position: relative;
    flex: 0 0 auto;
    padding: 6px 12px 2px;
    border-bottom: 1px solid #2a2a2a;
    background: #141414;
  }
  .tl-empty {
    margin: 6px 2px;
    font-size: 12px;
    color: #9a9a9a;
  }
  .tl-plot {
    position: relative;
    cursor: crosshair;
  }
  .tl-bands {
    position: absolute;
    inset: 0;
  }
  .band {
    transition: opacity 90ms;
  }
  .band.dim {
    opacity: 0.3;
  }
  .band.on {
    stroke: #fff;
    stroke-width: 1;
  }
  .here {
    fill: #d7d7d7;
  }
  .tl-dots {
    position: absolute;
    left: 0;
    pointer-events: none;
  }
  .tl-tip {
    position: absolute;
    bottom: 100%;
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    background: #1c1c1c;
    font-size: 10px;
    color: #ccc;
    pointer-events: none;
    white-space: nowrap;
  }
  .tl-tip img {
    object-fit: cover;
    border-radius: 2px;
    background: #222;
  }
  .tl-axis {
    min-height: 44px;
  }
  .tl-reset {
    position: absolute;
    right: 12px;
    top: 6px;
    font-size: 11px;
    padding: 1px 6px;
    border: 1px solid #3a3a3a;
    border-radius: 3px;
    background: #1c1c1c;
    color: #ccc;
    cursor: pointer;
  }
</style>
