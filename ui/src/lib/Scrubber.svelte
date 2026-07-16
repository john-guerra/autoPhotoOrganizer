<script>
  // Right-edge feed scrubber: a rail that shows the whole library's shape for the
  // current sort/grouping (density bars), labeled landmarks you can click to jump,
  // and a thumb tracking the viewport. Presentational — all positions come from
  // the pure scrubber/scale.js math; navigation is delegated to App via callbacks
  // (it owns the guarded jumpToPath). See the design spec.
  import { axisScale, thinLabels, landmarkLabel } from "./scrubber/scale.js";

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
</script>

<div
  class="scrubber"
  bind:clientHeight={railH}
  role="scrollbar"
  aria-label="Feed scrubber"
  aria-orientation="vertical"
  aria-valuenow={Math.round(thumbTop)}
  aria-valuemin={0}
  aria-valuemax={Math.round(railH)}
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
      <button
        class="label"
        style="top:{scale.toY(l)}px;"
        onclick={() => onjump?.(l.path)}
        title={`${landmarkLabel(l, { groupBy })} · ${l.count.toLocaleString()}`}
      >
        {landmarkLabel(l, { groupBy })}
      </button>
    {/each}

    <div class="thumb" style="top:{thumbTop}px; height:{thumbH}px;"></div>
  {/if}
</div>

<style>
  .scrubber {
    position: relative;
    width: 100%;
    height: 100%;
    user-select: none;
    overflow: hidden;
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
    padding: 1px 2px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .label:hover {
    color: #cfe0ff;
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
</style>
