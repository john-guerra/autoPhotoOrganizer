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
    landmarkAtCount,
  } from "./scrubber/scale.js";

  let {
    manifest,
    axis = "count",
    groupBy = [],
    sort = { by: "date_taken", dir: "asc" },
    topCount = 0,
    viewportCount = 0,
    onjump,
  } = $props();

  let railH = $state(0);

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
  const thumbTop = $derived(total > 0 ? (topCount / total) * railH : 0);
  const thumbH = $derived(
    total > 0 ? Math.max(18, (viewportCount / total) * railH) : 0
  );

  const nameOf = (l) => landmarkLabel(l, { groupBy });

  // --- Drag to scrub -------------------------------------------------------
  // Dragging PREVIEWS the target landmark (a floating label + the thumb follows
  // the cursor); the jump only commits on release. That keeps a drag across
  // hundreds of folders from firing hundreds of guarded feed jumps.
  let dragging = $state(false);
  let previewY = $state(0);
  let previewLandmark = $state(null);

  function railY(e) {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(railH, e.clientY - r.top));
  }
  function updatePreview(y) {
    previewY = y;
    // count axis: fromY returns a cumulative count. (Value axis lands with the
    // Settings toggle; while axis === "count" this is exact.)
    previewLandmark = manifest
      ? landmarkAtCount(manifest, scale.fromY(y))
      : null;
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
    if (!dragging) return;
    updatePreview(railY(e));
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
  role="scrollbar"
  aria-label="Feed scrubber — drag to scrub, click a landmark to jump"
  aria-orientation="vertical"
  aria-valuenow={Math.round(thumbTop)}
  aria-valuemin={0}
  aria-valuemax={Math.round(railH)}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={commitDrag}
  onpointercancel={commitDrag}
>
  {#if manifest && scale}
    <div class="track">
      {#each manifest.landmarks as l (l.key)}
        <div
          class="bar"
          style="top:{scale.toY(l)}px; height:{Math.max(
            1,
            (l.count / total) * railH
          )}px;"
        ></div>
      {/each}
    </div>

    {#each labels as l (l.key)}
      <div
        class="label"
        style="top:{scale.toY(l)}px;"
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
  .label:hover {
    color: #e8f0ff;
    background: rgba(18, 20, 24, 0.97);
    box-shadow: -3px 0 10px rgba(0, 0, 0, 0.45);
    z-index: 60;
  }
  .label:hover .label-text {
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
