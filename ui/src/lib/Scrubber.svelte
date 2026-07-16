<script>
  // Right-edge feed scrubber: a rail that shows the whole library's shape for the
  // current sort/grouping (density bars), labeled landmarks you can click or drag
  // to jump, and a thumb tracking the viewport. Presentational — all positions
  // come from the pure scrubber/scale.js math; navigation is delegated to App via
  // callbacks (it owns the guarded jumpToPath). See the design spec.
  import {
    axisScale,
    thinLabels,
    landmarkLabel,
    densityBins,
  } from "./scrubber/scale.js";

  let {
    manifest,
    axis = "count",
    groupBy = [],
    sort = { by: "date_taken", dir: "asc" },
    topValue = null,
    topFrac = 0,
    viewportCount = 0,
    times = null,
    timeMin = null,
    timeMax = null,
    onjump,
  } = $props();

  let railH = $state(0);
  let railW = $state(0);

  // Value getter for the value axis: finite only for numeric/date coarse dims
  // (year/day/rating/size); NaN for folder/camera/kind → axisScale falls back to
  // the count axis.
  const valueOf = (l) => {
    const n = Number(l.value);
    return Number.isFinite(n) ? n : NaN;
  };
  const scale = $derived(
    manifest && railH > 0 ? axisScale(axis, manifest, railH, { valueOf }) : null
  );
  const labels = $derived(
    manifest && scale
      ? thinLabels(manifest.landmarks, railH, 22, scale.toY)
      : []
  );
  const total = $derived(manifest?.total ?? 0);

  // Thumb position: interpolate the ACTIVE axis between the top-visible group's
  // landmark and the next one, by how far the viewport has scrolled through it.
  // Uses scale.toY (not a raw count), so the thumb sits on the same scale as the
  // landmarks on both axes and tracks smoothly inside a big group.
  const thumbTop = $derived.by(() => {
    if (!manifest || !scale || topValue == null) return 0;
    const ls = manifest.landmarks;
    const i = ls.findIndex((l) => l.value === topValue);
    if (i < 0) return 0;
    const y0 = scale.toY(ls[i]);
    const y1 = i + 1 < ls.length ? scale.toY(ls[i + 1]) : railH;
    return y0 + Math.max(0, Math.min(1, topFrac)) * (y1 - y0);
  });
  const thumbH = $derived(
    total > 0 ? Math.max(18, (viewportCount / total) * railH) : 0
  );

  const nameOf = (l) => landmarkLabel(l, { groupBy });

  // The value axis is only genuinely active when every coarse landmark has a
  // finite value (year/day/rating/size); for folder/categorical grouping axisScale
  // falls back to count, and so must the scent — else the time-linear scent would
  // sit on a different scale than the count-positioned landmarks.
  const valueActive = $derived(
    axis === "value" &&
      !!manifest &&
      manifest.landmarks.every((l) => Number.isFinite(valueOf(l)))
  );

  // Date "scent": on the VALUE axis (position ∝ time) the /api/times timestamps
  // draw a temporal-density profile — busy periods bulge — exactly like the top
  // timeline. On the COUNT axis density is uniform by construction (equal photos
  // per pixel), so we show the per-group count bars there instead.
  const SCENT_BINS = 140;
  const scent = $derived(
    valueActive && times?.length && timeMax > timeMin
      ? densityBins(times, timeMin, timeMax, SCENT_BINS)
      : null
  );
  const scentMax = $derived(scent ? Math.max(1, ...scent) : 1);
  const scentW = $derived(Math.max(20, railW * 0.6)); // px, scales with the rail

  // --- Drag to scrub -------------------------------------------------------
  // Dragging PREVIEWS the target landmark (a floating label + the thumb follows
  // the cursor); the jump only commits on release. That keeps a drag across
  // hundreds of folders from firing hundreds of guarded feed jumps.
  let dragging = $state(false);
  let previewY = $state(0);
  let previewLandmark = $state(null);
  let hoverY = $state(null);

  // Fisheye focus: 1 at the cursor, easing to 0 at FOCUS_R px away. Nearby labels
  // grow and lift so a dense rail stays scannable without resizing it.
  const FOCUS_R = 64;
  function focus(y) {
    if (hoverY == null || dragging) return 0;
    const d = Math.abs(y - hoverY);
    return d < FOCUS_R ? 1 - d / FOCUS_R : 0;
  }

  function railY(e) {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(railH, e.clientY - r.top));
  }
  // The landmark at-or-before rail position `y`. Resolving by RENDERED position
  // (toY) — not by fromY→count — is what makes scrub/click correct on BOTH axes:
  // on the value axis fromY returns a sort value, not a count, so the old
  // count-based lookup always landed on the wrong (early) landmark. Landmarks are
  // monotonic in toY on either axis, so a single forward scan finds it.
  function landmarkAtY(y) {
    const ls = manifest?.landmarks;
    if (!ls?.length || !scale) return null;
    let pick = ls[0];
    for (const l of ls) {
      if (scale.toY(l) <= y + 0.5) pick = l;
      else break;
    }
    return pick;
  }
  function updatePreview(y) {
    previewY = y;
    previewLandmark = landmarkAtY(y);
  }
  function onPointerDown(e) {
    if (!scale || (e.button != null && e.button !== 0)) return;
    // Press anywhere on the rail scrubs — including on a label (labels are just
    // visual affordances; the target landmark is whatever sits at the pointer's
    // Y). A plain click jumps to that spot; a drag previews then jumps on release.
    dragging = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* not all pointers are capturable */
    }
    updatePreview(railY(e));
  }
  function onPointerMove(e) {
    if (dragging) {
      updatePreview(railY(e));
    } else {
      hoverY = railY(e);
    }
  }
  function onPointerLeave() {
    hoverY = null;
  }
  function commitDrag(e) {
    if (!dragging) return;
    dragging = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (previewLandmark) onjump?.(previewLandmark.path);
    previewLandmark = null;
  }
</script>

<div
  class="scrubber"
  class:dragging
  bind:clientHeight={railH}
  bind:clientWidth={railW}
  role="scrollbar"
  tabindex="-1"
  aria-controls="feed-grid"
  aria-label="Feed scrubber — drag to scrub, click a landmark to jump"
  aria-orientation="vertical"
  aria-valuenow={Math.round(thumbTop)}
  aria-valuemin={0}
  aria-valuemax={Math.round(railH)}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={commitDrag}
  onpointercancel={commitDrag}
  onpointerleave={onPointerLeave}
>
  {#if manifest && scale}
    <div class="track">
      {#if scent}
        {#each scent as c, i (i)}
          <div
            class="scent"
            style="top:{(i / SCENT_BINS) * railH}px; height:{railH /
              SCENT_BINS +
              0.6}px; width:{3 + (c / scentMax) * scentW}px;"
          ></div>
        {/each}
      {:else}
        {#each manifest.landmarks as l (l.key)}
          <div
            class="bar"
            style="top:{scale.toY(l)}px; height:{Math.max(
              1,
              (l.count / total) * railH
            )}px;"
          ></div>
        {/each}
      {/if}
    </div>

    {#each labels as l (l.key)}
      {@const f = focus(scale.toY(l))}
      <div
        class="label"
        class:focused={f > 0.35}
        style="top:{scale.toY(l)}px; font-size:{10 + f * 4}px; z-index:{f > 0
          ? 40 + Math.round(f * 20)
          : 1};"
        title={`${nameOf(l)} · ${l.count.toLocaleString()}`}
      >
        <span class="label-text">{nameOf(l)}</span>
      </div>
    {/each}

    <div
      class="thumb"
      style="top:{dragging ? previewY : thumbTop}px; height:{dragging
        ? 3
        : thumbH}px;"
    ></div>

    {#if dragging && previewLandmark}
      <div class="preview" style="top:{previewY}px;">
        <span class="preview-name">{nameOf(previewLandmark)}</span>
        <span class="preview-count"
          >{previewLandmark.count.toLocaleString()}</span
        >
      </div>
    {/if}
  {/if}
</div>

<style>
  .scrubber {
    position: relative;
    width: 100%;
    height: 100%;
    user-select: none;
    /* visible so a hovered/dragged label can extend LEFT over the grid */
    overflow: visible;
    cursor: pointer;
  }
  .scrubber.dragging {
    cursor: grabbing;
  }
  .track {
    position: absolute;
    inset: 0;
  }
  .bar {
    position: absolute;
    right: 0;
    width: 5px;
    background: #3a4a63;
    border-radius: 2px;
    pointer-events: none;
  }
  /* Date scent: thin horizontal slices whose length encodes temporal density. */
  .scent {
    position: absolute;
    right: 0;
    background: #35506e;
    pointer-events: none;
  }
  .label {
    position: absolute;
    right: 8px;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: #9fb3d1;
    font-size: 10px;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    padding: 1px 3px;
    border-radius: 4px;
    max-width: calc(100% - 10px);
    z-index: 1;
  }
  .label-text {
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* On hover the label lifts above the grid and shows its full name, extending
     LEFT from the rail (the rail is the right-most column). */
  .label:hover,
  .label.focused {
    color: #e8f0ff;
    background: rgba(18, 20, 24, 0.97);
    box-shadow: -3px 0 10px rgba(0, 0, 0, 0.45);
  }
  .label:hover {
    z-index: 60;
  }
  .label:hover .label-text,
  .label.focused .label-text {
    max-width: none;
    overflow: visible;
  }
  .thumb {
    position: absolute;
    right: 0;
    width: 9px;
    background: rgba(138, 180, 255, 0.35);
    border: 1px solid #8ab4ff;
    border-radius: 5px;
    pointer-events: none;
  }
  /* Floating full-name preview shown while dragging. */
  .preview {
    position: absolute;
    right: 14px;
    transform: translateY(-50%);
    display: flex;
    gap: 8px;
    align-items: baseline;
    background: rgba(18, 20, 24, 0.98);
    border: 1px solid #3a4a63;
    box-shadow: -4px 0 14px rgba(0, 0, 0, 0.5);
    border-radius: 5px;
    padding: 3px 8px;
    white-space: nowrap;
    pointer-events: none;
    z-index: 70;
  }
  .preview-name {
    color: #e8f0ff;
    font-size: 11px;
  }
  .preview-count {
    color: #8ab4ff;
    font:
      600 10px/1 ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
  }
</style>
