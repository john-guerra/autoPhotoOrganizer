<script>
  import { imageUrl, fetchMeta, prepareVideo } from "./api.js";
  import { waitForJob } from "./jobs.js";
  import LoupeDetails from "./LoupeDetails.svelte";
  import LoupeFilmstrip from "./LoupeFilmstrip.svelte";
  import { loadVideoPrefs, saveVideoPrefs } from "./videoPrefs.js";

  /**
   * @type {{
   *   items: any[],
   *   index?: number,
   *   inSelection?: boolean,
   *   selectedCount?: number,
   *   selectedIds?: Set<number>,
   *   showDetails?: boolean,
   *   showFilmstrip?: boolean,
   *   thumbSize?: number,
   *   oncontextmenu?: (detail: { x: number, y: number }) => void,
   *   onclose?: () => void,
   *   ontoggleselect?: () => void,
   *   onrate?: (value: number) => void,
   * }}
   * `index` is two-way bound (the filmstrip moves it). `thumbSize` is the size
   * the filmstrip should REQUEST — the grid's current size, so the strip reuses
   * already-cached thumbnails (see LoupeFilmstrip). `onrate` is forwarded up
   * from LoupeDetails' star control.
   */
  let {
    items,
    index = $bindable(),
    inSelection = false,
    selectedCount = 0,
    selectedIds = new Set(),
    showDetails = true,
    showFilmstrip = true,
    thumbSize = 64,
    oncontextmenu,
    onclose,
    ontoggleselect,
    onrate,
  } = $props();

  // Right-click the photo → let App.svelte open the shared context menu at the
  // cursor, targeting the currently-loupe'd photo.
  function onContextMenu(e) {
    e.preventDefault();
    oncontextmenu?.({ x: e.clientX, y: e.clientY });
  }

  // `items` is App.svelte's resolvedPhotos — 1:1 with displayEntries, so a
  // collapsed section's placeholder (string id like "collapsed:...") can appear
  // here; `index` may transiently point at one while the caller reassigns.
  const isRealPhoto = (it) => it && typeof it.id === "number";
  const item = $derived(isRealPhoto(items[index]) ? items[index] : null);

  // Lazy, Loupe-scoped full metadata (incl. EXIF): fetch the current photo and
  // its immediate neighbours, cached by id. /api/meta persists on first read,
  // so re-views are instant. This keeps EXIF cost off the grid's enrichMeta.
  const detailMeta = new Map(); // id -> meta object from /api/meta
  let currentMeta = $state(null);
  $effect(() => {
    if (item) loadMeta(item.id);
  });

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
  let videoState = $state(null); // { status: "ready"|"preparing"|"error", url?, reason?, message? }

  // Audio is a property of the person watching, not of the file: the <video> used
  // to be hardcoded `muted`, so every clip started silent and had to be un-muted
  // by hand, every time. Remember what you chose and apply it to the next one.
  let { muted: videoMuted, volume: videoVolume } = loadVideoPrefs();
  function rememberAudio(e) {
    const el = e.currentTarget;
    videoMuted = el.muted;
    videoVolume = el.volume;
    saveVideoPrefs({ muted: videoMuted, volume: videoVolume });
  }

  /**
   * Start playing, and fall back to muted if the browser refuses.
   *
   * Autoplay WITH sound can be blocked (NotAllowedError) depending on how much
   * the browser trusts the origin. Muting and retrying keeps the picture moving —
   * a video that silently refuses to start looks broken. The saved preference is
   * deliberately NOT overwritten: the user still wants sound, and the next clip
   * (or the next launch, in the packaged app, where autoplay is permitted) should
   * try again rather than inherit a workaround as a setting.
   */
  function autoplay(el) {
    el.muted = videoMuted;
    el.volume = videoVolume;
    el.play().catch(() => {
      el.muted = true;
      el.play().catch(() => {
        // Still refused (no codec, aborted navigation) — the controls are right
        // there; the user can press play.
      });
    });
  }
  $effect(() => {
    if (item?.kind === "video") loadVideo(item.id);
    else if (item && item.kind !== "video") videoState = null;
  });

  /**
   * Can THIS machine decode that? The one question the server can't answer.
   *
   * HEVC support is a property of the computer, not of the file: Chromium ships
   * no software decoder and enables HEVC only where the OS/GPU provides one — so
   * the same clip plays natively on most Macs, plays on Windows only once the
   * HEVC Video Extension is installed, and usually cannot play on Linux. Rather
   * than transcode every HEVC clip on every machine (minutes of CPU, and a second
   * copy of the file, to work around a decoder that is often already there), the
   * server offers the original and we ask our own <video> element about it.
   *
   * Note this is a QUESTION, not a wait: canPlayType answers synchronously, from
   * the browser's own codec registry. No probing, no timeout, no "give it a
   * second and see". And a false yes still can't hurt us — the element's `error`
   * event catches it and falls back (see onVideoError).
   */
  function canDecode(mimeType) {
    return document.createElement("video").canPlayType(mimeType) !== "";
  }

  /**
   * The <video> gave up. If we were trying the original on the strength of
   * canDecode() (an HEVC file whose profile/level turned out to be more than this
   * machine's decoder could take), that guess is now disproven: convert it, which
   * always works. Otherwise the file is genuinely unplayable and the user must be
   * TOLD — a dead player with no message is the black-rectangle bug all over again.
   */
  function onVideoError() {
    if (videoState?.native && item) {
      loadVideo(item.id, { transcode: true });
      return;
    }
    videoState = {
      status: "error",
      message: "This video could not be played.",
    };
  }

  async function loadVideo(id, { transcode = false } = {}) {
    videoState = null;
    try {
      const r = await prepareVideo(id, { transcode });
      if (item?.id !== id) return; // navigated away while we asked
      if (r.ready) {
        // `verify` means the server is GUESSING this machine can decode the
        // original. Ask our decoder; if it says no, come straight back for the
        // conversion instead of showing a black frame.
        if (r.verify && !canDecode(r.verify)) {
          return loadVideo(id, { transcode: true });
        }
        videoState = { status: "ready", url: r.url, native: !!r.verify };
        return;
      }
      videoState = { status: "preparing", reason: r.reason, pct: null };
      const job = await waitForJob(r.jobId, (j) => {
        // A percentage, not a spinner. The conversion of a big camcorder AVI runs
        // for minutes, and "converting…" held for minutes is indistinguishable
        // from a hang. (A job with no countable total — a clip whose duration we
        // never read — keeps the spinner: a made-up number would be worse.)
        if (item?.id === id && j.total > 0) {
          videoState = {
            ...videoState,
            pct: Math.min(100, Math.round((j.done / j.total) * 100)),
          };
        }
      });
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
  $effect(() => {
    if (item) prefetch(index);
  });
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
    prefetchVideos(i);
  }

  /**
   * Start converting the video you are ABOUT to reach.
   *
   * A clip the browser can't decode (every .avi — Chromium won't even open the
   * container) has to be converted first, and that conversion runs for seconds on
   * a small clip and minutes on a big one. Waiting for it AFTER you arrive is the
   * whole complaint: the work is perfectly predictable, it just wasn't started
   * early enough. Asking the server to prepare the neighbours is exactly the same
   * bet the image prefetch above already makes, and it is idempotent — the server
   * hands back the already-running job rather than starting a second ffmpeg, and
   * an already-converted clip answers instantly from cache.
   *
   * Only the IMMEDIATE neighbours (±1), not the ±3 the images use: each miss
   * costs an ffmpeg process and a file on disk, not a decoded JPEG, so the window
   * is the one that pays for itself — where you go next.
   */
  const videoPrefetched = new Set(); // ids we've already asked the server about
  function prefetchVideos(i) {
    for (const d of [1, -1]) {
      const it = items[i + d];
      if (!isRealPhoto(it) || it.kind !== "video") continue;
      if (videoPrefetched.has(it.id)) continue;
      videoPrefetched.add(it.id);
      // Fire and forget: this is a HINT. If it fails, the real request the user's
      // own navigation makes will surface the error — a prefetch must never put a
      // message on screen for a photo the user isn't looking at.
      prepareVideo(it.id).catch(() => videoPrefetched.delete(it.id));
    }
  }
</script>

<div class="loupe" role="dialog" aria-modal="true">
  <button
    class="loupe-close"
    title="Close (Esc)"
    aria-label="Close"
    onclick={() => onclose?.()}>✕</button
  >
  {#if item}
    <button
      class="loupe-select"
      class:on={inSelection}
      title={inSelection ? "Deselect (X)" : "Select (X)"}
      aria-label={inSelection ? "Deselect photo" : "Select photo"}
      aria-pressed={inSelection}
      onclick={() => ontoggleselect?.()}
    >
      {#if inSelection}✓{/if}
    </button>
  {/if}
  <div class="body">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- contextmenu is a right-click affordance on the media stage; no ARIA
         role describes a bare image/video canvas, and keyboard users reach the
         same actions elsewhere. -->
    <div class="stage" oncontextmenu={onContextMenu}>
      {#if item}
        {#key item.id}
          {#if item.kind === "video"}
            <!-- Audio follows the remembered preference (videoPrefs), not a
                 hardcoded `muted` — with a muted retry if the browser blocks an
                 unmuted autoplay (see autoplay()). Controls give the scrub bar
                 that drives the server's Range requests. The {#key} tears
                 down/rebuilds the element on navigation, stopping playback. src
                 comes from the server (see loadVideo): the original when the
                 browser can decode it, a transcoded proxy when it can't. -->
            {#if videoState?.status === "ready"}
              <video
                src={videoState.url}
                controls
                playsinline
                preload="metadata"
                use:autoplay
                onvolumechange={rememberAudio}
                onerror={onVideoError}
              >
                <track kind="captions" />
              </video>
            {:else if videoState?.status === "error"}
              <p class="video-msg error">
                {videoState.message}
              </p>
            {:else}
              <div class="video-msg">
                <p>
                  <span class="thumb-spinner" aria-hidden="true"></span>
                  {videoState?.reason
                    ? `Converting for playback — ${videoState.reason}.`
                    : "Loading video…"}
                </p>
                <!-- A real bar once the server knows how long the clip is. A big
                     camcorder AVI converts for minutes, and a spinner held for
                     minutes reads as a hang. -->
                {#if videoState?.pct != null}
                  <progress
                    class="video-progress"
                    max="100"
                    value={videoState.pct}
                  ></progress>
                  <span class="video-pct">{videoState.pct}%</span>
                {/if}
              </div>
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
        {onrate}
      />
    {/if}
  </div>
  {#if showFilmstrip}
    <LoupeFilmstrip
      {items}
      {index}
      {selectedIds}
      requestSize={thumbSize}
      onselect={(d) => (index = d.index)}
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
    flex-wrap: wrap;
    justify-content: center;
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
  .video-msg p {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0;
  }
  .video-msg.error {
    color: #ff8a80;
    border-color: #5a2a2a;
  }
  .video-progress {
    flex: 1 1 12rem;
    height: 6px;
    accent-color: #4c9aff;
  }
  .video-pct {
    font-variant-numeric: tabular-nums;
    color: #8a8f98;
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
