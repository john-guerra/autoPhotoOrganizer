<script>
  import Stars from "./Stars.svelte";
  import MiniMap from "./MiniMap.svelte";
  import {
    formatAperture,
    formatShutter,
    formatIso,
    formatFocal,
    formatSize,
    formatDimensions,
  } from "./exifFormat.js";
  import { dateRows } from "./photoDates.js";

  /**
   * @type {{
   *   item?: any,
   *   meta?: any,
   *   inSelection?: boolean,
   *   selectedCount?: number,
   *   onrate?: (value: number) => void,
   * }}
   * `item` is the current photo (items[index]); `meta` is the full detail meta
   * from /api/meta (or null while loading). `onrate` forwards the star click up.
   */
  let {
    item = null,
    meta = null,
    inSelection = false,
    selectedCount = 0,
    onrate,
    /** The feed's current sort attribute, so the Dates section can mark which
     *  of the three is deciding this photo's position (#349). */
    sortBy = "",
  } = $props();

  /** Every date this photo has, unmerged — see `photoDates.js`. */
  const dates = $derived(dateRows(meta, sortBy));

  const DASH = "—";
  const or = (s) => (s ? s : DASH);

  // Prefer freshly-fetched meta, fall back to the feed item's own fields.
  const takenAt = $derived(meta?.takenAt ?? item?.takenAt ?? null);
  const dims = $derived(
    formatDimensions(
      meta?.width ?? item?.width ?? 0,
      meta?.height ?? item?.height ?? 0
    )
  );
  const folder = $derived(meta?.folder ?? null);
  const isVideo = $derived(item?.kind === "video");

  // Only meta (not item) carries GPS — the feed row never has it (#175
  // follow-up). Both lat AND lon: place.js's Unknown sentinel is "", which is
  // truthy-empty but not a valid coordinate, so gate on the numbers, not on
  // the derived name strings.
  const hasLocation = $derived(
    typeof meta?.lat === "number" && typeof meta?.lon === "number"
  );
  const placeHierarchy = $derived(
    [
      meta?.placeCountry,
      meta?.placeRegion,
      meta?.placeCity,
      meta?.placeNeighborhood,
    ]
      .filter(Boolean)
      .join(" › ")
  );

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

    <!-- THE THREE DATES, UNMERGED (#349).

         "Taken" above is a COALESCE, and that is right for reading and useless
         for debugging: when a photo lands in a group you did not expect, the
         merged value is the one thing that cannot tell you why. A Pixel backup
         folder grouped into 1984 under "Created" because macOS reports
         birthtime as its own unknown-sentinel for files copied off a phone —
         EXIF and mtime both said 2025. -->
    {#if dates.length}
      <section data-testid="loupe-dates">
        <h4>Dates</h4>
        <dl>
          {#each dates as d (d.key)}
            <dt class:drives={d.drives}>
              {d.label}
              {#if d.drives}<span
                  class="tag"
                  title="This is the date the feed is currently sorting and grouping by"
                  >sorting by this</span
                >{/if}
            </dt>
            <dd
              class:drives={d.drives}
              class:suspect={!!d.note && d.key === "btime"}
              data-testid={`loupe-date-${d.key}`}
            >
              {fmtDate(d.ms)}
              {#if d.note}
                <span class="note">{d.note}</span>
              {/if}
            </dd>
          {/each}
        </dl>
      </section>
    {/if}

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

    {#if hasLocation}
      <section>
        <h4>Location</h4>
        {#if placeHierarchy}
          <div class="v place">{placeHierarchy}</div>
        {/if}
        <MiniMap lat={meta.lat} lon={meta.lon} placeName={meta.placeCity} />
      </section>
    {/if}

    <section class="rating-row">
      <h4>Rating</h4>
      <Stars rating={item.rating ?? 0} full interactive {onrate} />
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
  .place {
    color: #eee;
    margin-bottom: 0.4rem;
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

  /* --- the Dates section (#349) ------------------------------------------
     Two states, and the difference between them is the whole point: DRIVES
     means "this is the one placing the photo in the feed", SUSPECT means
     "this value is not a real date". A photo lands in 1984 only when both are
     true of the same row, which is exactly what the eye should be drawn to. */
  dt.drives,
  dd.drives {
    color: #fff;
  }
  .tag {
    display: inline-block;
    margin-left: 6px;
    padding: 0 5px;
    border-radius: 3px;
    background: #2e8b57;
    color: #06121f;
    font-size: 0.65rem;
    font-weight: 600;
    vertical-align: 1px;
  }
  dd.suspect {
    color: #e8b339;
  }
  .note {
    display: block;
    color: #8a8a8a;
    font-size: 0.7rem;
    line-height: 1.35;
    /* Left, against the right-aligned dates above it: a sentence set ragged-left
       is read as prose, and this one has to actually be read. */
    text-align: left;
    margin-top: 1px;
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
