<script>
  import { createEventDispatcher } from "svelte";
  import { imageUrl, fetchMeta, prepareVideo } from "./api.js";
  import { waitForJob } from "./jobs.js";
  import LoupeDetails from "./LoupeDetails.svelte";
  import LoupeFilmstrip from "./LoupeFilmstrip.svelte";

  const dispatch = createEventDispatcher();

  // Right-click the photo → let App.svelte open the shared context menu at the
  // cursor, targeting the currently-loupe'd photo.
  function onContextMenu(e) {
    e.preventDefault();
    dispatch("contextmenu", { x: e.clientX, y: e.clientY });
  }

  export let items;
  export let index; // current position in items (two-way bound)
  export let inSelection = false; // is the current photo in the selection?
  export let selectedCount = 0; // total selected, for the panel
  export let selectedIds = new Set(); // for the filmstrip's ✓ markers
  export let showDetails = true;
  export let showFilmstrip = true;

  // `items` is App.svelte's resolvedPhotos — 1:1 with displayEntries, so a
  // collapsed section's placeholder (string id like "collapsed:...") can appear
  // here; `index` may transiently point at one while the caller reassigns.
  const isRealPhoto = (it) => it && typeof it.id === "number";
  $: item = isRealPhoto(items[index]) ? items[index] : null;

  // Lazy, Loupe-scoped full metadata (incl. EXIF): fetch the current photo and
  // its immediate neighbours, cached by id. /api/meta persists on first read,
  // so re-views are instant. This keeps EXIF cost off the grid's enrichMeta.
  const detailMeta = new Map(); // id -> meta object from /api/meta
  let currentMeta = null;
  $: if (item) loadMeta(item.id);

  async function loadMeta(id) {
    currentMeta = detailMeta.get(id) ?? null;
    const ids = [];
    for (let d = -1; d <= 1; d++) {
      const it = items[index + d];
      if (isRealPhoto(it) && !detailMeta.has(it.id)) ids.push(it.id);
    }
    if (!ids.length) return;
    try {
      const metas = await fetchMeta(ids);
      for (const m of metas) detailMeta.set(m.id, m);
      if (item && item.id === id)
        currentMeta = detailMeta.get(id) ?? currentMeta;
    } catch {
      /* metadata is an enhancement; the panel falls back to item fields */
    }
  }

  // --- Video playback -------------------------------------------------------
  // The browser can't decode every video ffmpeg can read: an old camcorder .avi
  // (MPEG-4 + MP3) plays its AUDIO and shows nothing at all, because Chromium
  // has no MPEG-4 Part 2 decoder. So we ask the server what to play rather than
  // pointing <video> at the file and hoping — a black rectangle with sound is
  // the worst possible failure, since it looks like a broken FILE, not a
  // missing codec. The server hands back a URL, or transcodes one for us.
  let videoState = null; // { status: "ready"|"preparing"|"error", url?, reason?, message? }
  $: if (item?.kind === "video") loadVideo(item.id);
  $: if (item && item.kind !== "video") videoState = null;

  async function loadVideo(id) {
    videoState = null;
    try {
      const r = await prepareVideo(id);
      if (item?.id !== id) return; // navigated away while we asked
      if (r.ready) {
        videoState = { status: "ready", url: r.url };
        return;
      }
      videoState = { status: "preparing", reason: r.reason };
      const job = await waitForJob(r.jobId);
      if (item?.id !== id) return;
      if (job.status === "done") {
        videoState = { status: "ready", url: job.result.url };
      } else if (job.status === "canceled") {
        videoState = { status: "error", message: "Conversion canceled." };
      } else {
        videoState = {
          status: "error",
          message: job.error || "Could not convert this video for playback.",
        };
      }
    } catch (e) {
      if (item?.id !== id) return;
      videoState = { status: "error", message: e.message };
    }
  }

  // Image prefetch: keep ±3 neighbours warm so navigation never waits on decode.
  const warm = new Map(); // id -> Image()
  $: if (item) prefetch(index);
  function prefetch(i) {
    const wanted = new Set();
    for (let d = -3; d <= 3; d++) {
      const it = items[i + d];
      if (!isRealPhoto(it)) continue;
      if (it.kind === "video") continue; // an Image() can't preload a video
      wanted.add(it.id);
      if (!warm.has(it.id)) {
        const img = new Image();
        img.src = imageUrl(it.id, it.mtimeMs);
        warm.set(it.id, img);
      }
    }
    for (const id of warm.keys()) if (!wanted.has(id)) warm.delete(id);
  }
</script>

<div class="loupe" role="dialog" aria-modal="true">
  <button
    class="loupe-close"
    title="Close (Esc)"
    aria-label="Close"
    on:click={() => dispatch("close")}>✕</button
  >
  {#if item}
    <button
      class="loupe-select"
      class:on={inSelection}
      title={inSelection ? "Deselect (X)" : "Select (X)"}
      aria-label={inSelection ? "Deselect photo" : "Select photo"}
      aria-pressed={inSelection}
      on:click={() => dispatch("toggleselect")}
    >
      {#if inSelection}✓{/if}
    </button>
  {/if}
  <div class="body">
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <!-- contextmenu is a right-click affordance on the media stage; no ARIA
         role describes a bare image/video canvas, and keyboard users reach the
         same actions elsewhere. -->
    <div class="stage" on:contextmenu={onContextMenu}>
      {#if item}
        {#key item.id}
          {#if item.kind === "video"}
            <!-- muted so the browser doesn't block autoplay; controls give the
                 scrub bar that drives the server's Range requests. The {#key}
                 tears down/rebuilds the element on navigation, stopping playback.
                 src comes from the server (see loadVideo): the original when the
                 browser can decode it, a transcoded proxy when it can't. -->
            {#if videoState?.status === "ready"}
              <video
                src={videoState.url}
                controls
                autoplay
                muted
                playsinline
                preload="metadata"
              >
                <track kind="captions" />
              </video>
            {:else if videoState?.status === "error"}
              <p class="video-msg error">
                {videoState.message}
              </p>
            {:else}
              <p class="video-msg">
                <span class="thumb-spinner" aria-hidden="true"></span>
                {videoState?.reason
                  ? `Converting for playback — ${videoState.reason}.`
                  : "Loading video…"}
              </p>
            {/if}
          {:else}
            <img src={imageUrl(item.id, item.mtimeMs)} alt={item.name} />
          {/if}
        {/key}
      {/if}
    </div>
    {#if showDetails}
      <LoupeDetails
        {item}
        meta={currentMeta}
        {inSelection}
        {selectedCount}
        on:rate
      />
    {/if}
  </div>
  {#if showFilmstrip}
    <LoupeFilmstrip
      {items}
      {index}
      {selectedIds}
      on:select={(e) => (index = e.detail.index)}
    />
  {/if}
</div>

<style>
  .loupe {
    position: fixed;
    inset: 0;
    background: #0a0a0a;
    display: flex;
    flex-direction: column;
    z-index: 100;
  }
  /* Says what is happening to a video the browser can't decode yet, instead of
     the black rectangle (with sound!) this feature exists to eliminate. */
  .video-msg {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    color: #bbb;
    font-size: 0.9rem;
    padding: 1rem 1.25rem;
    background: #161616;
    border: 1px solid #2c2c2c;
    border-radius: 8px;
    max-width: 32rem;
    text-align: center;
  }
  .video-msg.error {
    color: #ff8a80;
    border-color: #5a2a2a;
  }
  .thumb-spinner {
    width: 16px;
    height: 16px;
    flex: none;
    border: 2px solid #444;
    border-top-color: #999;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .loupe-close {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 10;
    width: 34px;
    height: 34px;
    padding: 0;
    line-height: 1;
    background: rgba(20, 20, 20, 0.7);
    border: 1px solid #444;
    color: #e8e8e8;
    border-radius: 50%;
    font-size: 1rem;
    cursor: pointer;
  }
  .loupe-close:hover {
    background: rgba(50, 50, 50, 0.9);
  }
  .loupe-select {
    position: absolute;
    top: 12px;
    left: 12px;
    z-index: 10;
    width: 34px;
    height: 34px;
    padding: 0;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(20, 20, 20, 0.7);
    border: 1.5px solid rgba(255, 255, 255, 0.85);
    color: #1a1400;
    border-radius: 50%;
    font-size: 1rem;
    font-weight: 700;
    cursor: pointer;
  }
  .loupe-select:hover {
    border-color: #fff;
  }
  .loupe-select.on {
    background: #ffd24c;
    border-color: #ffd24c;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .stage {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .stage img,
  .stage video {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    box-shadow: 0 4px 30px rgba(0, 0, 0, 0.6);
  }
</style>
