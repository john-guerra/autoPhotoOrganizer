<script>
  import Stars from "./Stars.svelte";
  import {
    formatAperture,
    formatShutter,
    formatIso,
    formatFocal,
    formatSize,
    formatDimensions,
  } from "./exifFormat.js";

  export let item = null; // current photo (from items[index])
  export let meta = null; // full detail meta from /api/meta (or null while loading)
  export let inSelection = false;
  export let selectedCount = 0;

  const DASH = "—";
  const or = (s) => (s ? s : DASH);

  // Prefer freshly-fetched meta, fall back to the feed item's own fields.
  $: takenAt = meta?.takenAt ?? item?.takenAt ?? null;
  $: dims = formatDimensions(
    meta?.width ?? item?.width ?? 0,
    meta?.height ?? item?.height ?? 0
  );
  $: folder = meta?.folder ?? null;
  $: isVideo = item?.kind === "video";

  function fmtDate(iso) {
    if (!iso) return DASH;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? DASH : d.toLocaleString();
  }
  function fmtDuration(sec) {
    if (typeof sec !== "number" || sec <= 0) return DASH;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
</script>

<aside class="details">
  {#if item}
    <section>
      <h4>File</h4>
      <div class="v name" title={item.name}>{item.name}</div>
      {#if folder}<div class="v sub" title={folder}>{folder}</div>{/if}
      <dl>
        <dt>Size</dt>
        <dd>{or(formatSize(meta?.size ?? item?.size))}</dd>
        <dt>Kind</dt>
        <dd>{item.kind}</dd>
        {#if isVideo}
          <dt>Length</dt>
          <dd>{fmtDuration(meta?.duration ?? item?.duration)}</dd>
        {/if}
      </dl>
    </section>

    <section>
      <h4>Image</h4>
      <dl>
        <dt>Dimensions</dt>
        <dd>{or(dims)}</dd>
        <dt>Taken</dt>
        <dd>{fmtDate(takenAt)}</dd>
      </dl>
    </section>

    {#if !isVideo}
      <section>
        <h4>Camera</h4>
        <dl>
          <dt>Camera</dt>
          <dd>{or(meta?.camera)}</dd>
          <dt>Lens</dt>
          <dd>{or(meta?.lens)}</dd>
          <dt>Aperture</dt>
          <dd>{or(formatAperture(meta?.aperture))}</dd>
          <dt>Shutter</dt>
          <dd>{or(formatShutter(meta?.shutter))}</dd>
          <dt>ISO</dt>
          <dd>{or(formatIso(meta?.iso))}</dd>
          <dt>Focal</dt>
          <dd>{or(formatFocal(meta?.focalLength))}</dd>
        </dl>
      </section>
    {/if}

    <section class="rating-row">
      <h4>Rating</h4>
      <Stars rating={item.rating ?? 0} full interactive on:rate />
    </section>

    <section class="select-row">
      <span class="select-state" class:on={inSelection}>
        {inSelection ? "✓ Selected" : "Click ○ or press X to select"}
      </span>
      {#if selectedCount > 0}
        <span class="select-total">{selectedCount} selected</span>
      {/if}
    </section>
  {/if}
</aside>

<style>
  .details {
    width: 260px;
    flex: 0 0 260px;
    overflow-y: auto;
    background: #111;
    border-left: 1px solid #222;
    color: #ddd;
    font-size: 0.82rem;
    padding: 0.75rem 0.9rem;
  }
  section {
    margin-bottom: 1rem;
  }
  h4 {
    margin: 0 0 0.35rem;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #888;
  }
  .name {
    color: #fff;
    word-break: break-all;
  }
  .sub {
    color: #888;
    font-size: 0.75rem;
    word-break: break-all;
    margin-top: 2px;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    margin: 0.35rem 0 0;
  }
  dt {
    color: #888;
  }
  dd {
    margin: 0;
    color: #eee;
    text-align: right;
    word-break: break-word;
  }
  .rating-row :global(.stars) {
    font-size: 1rem;
  }
  .select-state {
    font-size: 0.75rem;
    color: #777;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 3px 8px;
  }
  .select-state.on {
    color: #1a1400;
    background: #ffd24c;
    border-color: #ffd24c;
    font-weight: 600;
  }
  .select-total {
    display: block;
    margin-top: 4px;
    font-size: 0.75rem;
    color: #ffd24c;
  }
</style>
