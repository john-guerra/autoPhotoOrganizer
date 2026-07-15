<script module>
  // WIP (issue #90 — "collapse to snapshot → thumbs broken").
  //
  // A single resilient thumbnail for the snapshot strip. The grid tile
  // (Thumb.svelte) already recovers from a failed/stalled thumbnail request
  // (stall timer → retry → embedded-preview fallback); the strip used to render
  // a bare <img> with no such handling, so any transient failure — a dropped
  // connection under the browser's per-origin cap, a dev-proxy hiccup, a
  // momentary error mid-scan — left the browser's broken-image glyph stuck
  // until the whole strip re-rendered (issue #90). This is the lightweight
  // strip-local counterpart: same idea, per-thumb state, no grid chrome.
  export const SNAP_STALL_MS = 12000; // an <img> has no native load timeout — treat a never-settling request as failed
  export const SNAP_MAX_RETRIES = 2; // full-thumbnail attempts before falling back to the embedded preview
  export const SNAP_RETRY_BACKOFF_MS = [400, 1200]; // backoff per retry — lets a transient generation/connection error clear
</script>

<script>
  import { thumbUrl, previewUrl } from "./api.js";

  /**
   * @type {{ id: any, size?: number, v?: any }}
   * `size` is the thumbnail longest edge — a shared bucket the grid also uses,
   * so the strip reuses the grid's cache instead of forcing a unique cold size.
   * `v` is an optional mtime cache-buster (browser-side only; server ignores it).
   */
  let { id, size = 320, v = undefined } = $props();

  // Only `failed` and `activeSrc` are rendered, so only they need to be $state;
  // the rest are internal load-machine bookkeeping read solely inside handlers.
  let attempt = 0; // full-thumbnail retry count
  let usingPreview = false; // exhausted retries → showing the embedded preview
  let failed = $state(false); // preview failed too — surface a visible placeholder
  let activeSrc = $state(null);
  let stallTimer;
  let retryTimer;

  // Restart from scratch whenever the identity of what we're showing changes.
  // Keyed on id+size+v so a rescan swapping the file under this id, or a zoom
  // changing the bucket, re-attempts cleanly. startFor guards on currentKey so
  // this effect is idempotent when unrelated state changes.
  $effect(() => {
    startFor(`${id}:${size}:${v}`);
  });

  // Clear pending timers when the component is destroyed (was onDestroy).
  $effect(() => () => {
    clearTimeout(stallTimer);
    clearTimeout(retryTimer);
  });

  let currentKey = null;
  function startFor(key) {
    if (key === currentKey) return;
    currentKey = key;
    clearTimeout(retryTimer);
    attempt = 0;
    usingPreview = false;
    failed = false;
    load(thumbUrl(id, size, v));
  }

  function load(url) {
    clearTimeout(stallTimer);
    activeSrc = url;
    stallTimer = setTimeout(() => {
      if (activeSrc === url) onError();
    }, SNAP_STALL_MS);
  }

  function onLoad() {
    clearTimeout(stallTimer);
  }

  function onError() {
    clearTimeout(stallTimer);
    if (!usingPreview && attempt < SNAP_MAX_RETRIES) {
      // Backoff, then re-request with a cache-bust so a cached error/partial
      // response can't wedge the retry.
      const delay = SNAP_RETRY_BACKOFF_MS[attempt] ?? 1200;
      attempt += 1;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(
        () => load(`${thumbUrl(id, size, v)}&retry=${attempt}`),
        delay
      );
    } else if (!usingPreview) {
      // Full thumbnail is not coming — fall back to the fast embedded preview.
      usingPreview = true;
      load(previewUrl(id, v));
    } else {
      // Even the preview failed: stop retrying and show a visible "couldn't
      // load" placeholder rather than the browser's broken-image glyph or a
      // silent blank (CLAUDE.md: never fail silently).
      clearTimeout(stallTimer);
      failed = true;
      activeSrc = null;
    }
  }

</script>

{#if failed}
  <span class="snap-broken" title="Thumbnail unavailable">⚠</span>
{:else}
  <img
    src={activeSrc}
    onload={onLoad}
    onerror={onError}
    loading="lazy"
    alt=""
  />
{/if}

<style>
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .snap-broken {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: #8a8a8a;
    font-size: 1.1rem;
    background: #242424;
    user-select: none;
  }
</style>
