<script context="module">
  export const PEEK_STEP_PX = 6; // px offset per peeking layer (diagonal: horizontal alternating + vertical), tuned for visibility
  export const MAX_PEEK_DEPTH = 2; // visual depth cap — peeks beyond this render at the same max offset, keeping the tile's footprint small and neat regardless of actual stack size
  export const PEEK_VERTICAL_PX = 2; // flat vertical offset for every peek layer (not scaled by depth) — a subtle "slightly offset" cue, kept tiny since it isn't reserved for in the grid layout
  export const STALL_MS = 12000; // an <img> load has no native timeout; treat a request that neither loads nor errors within this window as stalled
  export const PREVIEW_DELAY_MS = 150; // only fetch the embedded-preview fallback if the full thumbnail hasn't already loaded by then — avoids a wasted request on every already-cached (warm) view, where the full thumbnail resolves well under this delay
</script>

<script>
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { thumbUrl, previewUrl, formatDuration } from "./api.js";
  import { formatSize } from "./exifFormat.js";
  import Stars from "./Stars.svelte";

  const dispatch = createEventDispatcher();

  export let item; // {id, name, rating, mtimeMs}
  export let box; // {x, y, width, height} from the justified layout
  export let pad = 0; // grid frame inset (abs children ignore CSS padding)
  export let size = 640; // thumb longest edge; higher zoom requests sharper
  export let selected = false;
  export let inSelection = false; // member of the multi-select set (batch export)
  export let showSize = false; // show the file-size pill (when sorting by size)
  export let stackCount = undefined; // set when this tile is a collapsed stack's cover
  export let inExpandedStack = false; // true when this photo is a member of a currently-expanded stack
  export let isCurrentCover = false; // true when this expanded member currently resolves as its stack's cover
  export let stackPeekItems = []; // this stack's other members (excludes the cover), for the peeking-photos visual
  export let stackMarginPx = 0; // horizontal margin reserved in the layout for this stack's peek layers (0 for non-stack tiles)
  // App already loaded this id's thumbnail once (thumbStatus === 'ok', reset
  // only on scan). True when a group is re-expanded after being collapsed: the
  // bytes are in the browser cache, so skip the blank→observer→spinner→fade
  // lifecycle a fresh mount would otherwise re-run and paint the cached image
  // straight away (issue #41). Measured: the re-fetches on expand are ~80%
  // cache hits (transferSize 0), yet the tiles still rebuilt from blank — this
  // is the client-side lifecycle cost, not the network.
  export let warm = false;

  let el;
  // `warm` tiles skip the IntersectionObserver gate: set `src` at mount instead
  // of waiting for the observer to re-confirm a visibility that hasn't changed.
  let visible = warm;
  let loaded = false;
  // `warm` ⇒ the image is cache-warm, so drop the fade from the first paint
  // (the `instant` class). detectCache may also set this for a cold-but-cached
  // tile, but its synchronous `complete` check is unreliable right after `src`
  // is assigned, so `warm` is the dependable signal for the re-expand case.
  let cacheHit = warm; // the <img> is browser-cached → skip the fade (issue #41)
  let failed = false; // server 500'd, or the request stalled past STALL_MS
  let retryNonce = 0; // bumped by the retry click to force a fresh request past caches
  let observer;
  let stallTimer;
  let previewSrc = null; // the fast-tier embedded-preview URL, set only if the full thumbnail hasn't loaded within PREVIEW_DELAY_MS
  let previewTimer;

  // Recompute the src whenever the tile is visible OR the item/size changes.
  // Svelte reuses this component across rescans (keyed by id), so `item` can
  // swap to a different file under the same id — the mtime version keeps the
  // URL correct.
  $: src = visible
    ? thumbUrl(item.id, size, item.mtimeMs) +
      (retryNonce ? `&retry=${retryNonce}` : "")
    : null;
  $: if (src) armAttempt(src);

  // Each new attempt (initial load or retry) reports "pending" to the grid's
  // aggregate progress counter, resets visible state, and arms the stall
  // timer — a plain <img> has no load timeout of its own, so a request that
  // never settles (a wedged sharp/exiftool extraction under heavy scan load)
  // would otherwise leave the tile blank forever with no way to tell "still
  // loading" apart from "silently broken".
  function armAttempt(url) {
    loaded = false; // re-fade in when the source changes
    failed = false;
    previewSrc = null;
    dispatch("attempt", { id: item.id });
    clearTimeout(stallTimer);
    clearTimeout(previewTimer);
    stallTimer = setTimeout(() => {
      if (src === url) settle(false);
    }, STALL_MS);
    previewTimer = setTimeout(() => {
      if (src === url && !loaded)
        previewSrc = previewUrl(item.id, item.mtimeMs);
    }, PREVIEW_DELAY_MS);
  }

  function settle(ok) {
    clearTimeout(stallTimer);
    clearTimeout(previewTimer);
    // RAW thumbnails fail fast (extension check, no decode attempt) — almost
    // always well under PREVIEW_DELAY_MS — so the timer above just got
    // cancelled before it could ever fire. Without this, a RAW tile (whose
    // Retry button is suppressed, since there's nothing to retry) would be
    // left permanently blank. Falling back immediately on any failure that
    // beats the delay covers that case, and any other fast failure too.
    if (!ok && !previewSrc) previewSrc = previewUrl(item.id, item.mtimeMs);
    loaded = ok;
    failed = !ok;
    dispatch("settled", { id: item.id, ok });
  }

  // Cache-hit fast path (issue #41). Thumbnails are served `Cache-Control:
  // immutable`, so re-mounting an already-loaded group — e.g. expanding a
  // section you just collapsed — recreates each <img> against a warm browser
  // cache. Such an <img> is already `complete` with real dimensions the instant
  // it's created, and its `load` event may not fire again. Without this, every
  // tile would restart at `loaded = false` (spinner) and fade back in over
  // 0.2s — the visible "flicker on expand". Detecting `complete` at creation
  // (a state check, not a timer) lets us mark it loaded synchronously, before
  // the first paint, and the `instant` class drops the fade so cached tiles
  // just appear. A genuinely-uncached <img> is not `complete` here, so it keeps
  // the normal spinner + fade.
  function detectCache(node) {
    if (node.complete && node.naturalWidth > 0) {
      cacheHit = true;
      settle(true);
    } else {
      cacheHit = false;
    }
  }

  function retry() {
    retryNonce += 1;
  }

  onDestroy(() => {
    clearTimeout(stallTimer);
    clearTimeout(previewTimer);
  });

  // Split alternately: chronologically-nearer non-cover members peek out
  // closer to the cover (right first, then left, then right again, ...).
  // Sliced to MAX_PEEK_DEPTH per side: every layer beyond that depth
  // renders at the same clamped offset and is therefore fully occluded
  // by the layer in front of it (same box, higher z-index) — rendering
  // them anyway would mean fetching/decoding/compositing a thumbnail
  // <img> for every extra member of a large burst for zero visible
  // effect. The ×N badge already carries the true, uncapped count.
  $: rightPeekItems = stackPeekItems
    .filter((_, i) => i % 2 === 0)
    .slice(0, MAX_PEEK_DEPTH);
  $: leftPeekItems = stackPeekItems
    .filter((_, i) => i % 2 === 1)
    .slice(0, MAX_PEEK_DEPTH);

  onMount(() => {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            visible = true;
            observer.disconnect();
          }
        }
      },
      // A generous margin means far more tiles become "visible" (and start
      // fetching their thumbnail) than are actually on screen — compounds
      // with the outer virtualization window's own overscan (see
      // updateVisibleRange in App.svelte) after a big jump. Each extra
      // fetch competes for the server's thumbnail-generation throughput
      // (sharp/exiftool), so the visible tiles' own loads get queued
      // behind off-screen ones — on a cold cache this reads as the whole
      // screen "flickering" as images pop in over an extended window,
      // rather than the visible ones settling quickly. Smaller margin
      // still pre-fetches a bit ahead of ordinary scrolling, just not
      // several rows' worth on every side.
      { rootMargin: "150px" }
    );
    observer.observe(el);
  });

  onDestroy(() => observer?.disconnect());

  // (Selection reveal is owned by App.svelte's revealSelected(), triggered by
  // active navigation only — a tile no longer scrolls the page itself. This
  // deliberately removes the old reflow-triggered re-center, which hijacked
  // the user's scroll on every metadata-driven layout change. See issue #40.)
</script>

<div
  class="thumb-wrap"
  style={`top:${box.y + pad}px;left:${box.x + pad}px;width:${box.width}px;height:${box.height}px;`}
>
  {#if src}
    {#each rightPeekItems as peekItem, i (peekItem.id)}
      <img
        src={thumbUrl(peekItem.id, size, peekItem.mtimeMs)}
        alt=""
        loading="lazy"
        class="stack-peek"
        style={`left:${stackMarginPx}px; width:calc(100% - ${2 * stackMarginPx}px); transform: translate(${Math.min(i + 1, MAX_PEEK_DEPTH) * PEEK_STEP_PX}px, ${PEEK_VERTICAL_PX}px); z-index: ${rightPeekItems.length - i};`}
      />
    {/each}
    {#each leftPeekItems as peekItem, i (peekItem.id)}
      <img
        src={thumbUrl(peekItem.id, size, peekItem.mtimeMs)}
        alt=""
        loading="lazy"
        class="stack-peek"
        style={`left:${stackMarginPx}px; width:calc(100% - ${2 * stackMarginPx}px); transform: translate(${-Math.min(i + 1, MAX_PEEK_DEPTH) * PEEK_STEP_PX}px, ${PEEK_VERTICAL_PX}px); z-index: ${leftPeekItems.length - i};`}
      />
    {/each}
  {/if}
  <button
    bind:this={el}
    class="thumb"
    class:selected
    data-id={item.id}
    title={item.name}
    style={stackMarginPx ? `inset: 0 ${stackMarginPx}px;` : ""}
    on:click
    on:contextmenu
  >
    <button
      class="select-circle"
      class:on={inSelection}
      type="button"
      title={inSelection ? "Deselect" : "Select"}
      aria-label={inSelection ? "Deselect photo" : "Select photo"}
      aria-pressed={inSelection}
      on:click|stopPropagation={() => dispatch("toggleselect")}
    >
      {#if inSelection}✓{/if}
    </button>
    {#if src && previewSrc && !loaded}
      <img
        src={previewSrc}
        alt=""
        loading="lazy"
        class="preview"
        on:error={() => (previewSrc = null)}
      />
    {/if}
    {#if src}
      {#key `${item.id}:${item.mtimeMs}`}
        <img
          {src}
          alt={item.name}
          loading="lazy"
          class="cover"
          class:loaded
          class:instant={cacheHit}
          use:detectCache
          on:load={() => settle(true)}
          on:error={() => settle(false)}
        />
      {/key}
    {/if}
    {#if src && !loaded && !failed}
      <span class="thumb-spinner" aria-hidden="true"></span>
    {/if}
    {#if failed && item.kind !== "raw"}
      <button
        class="thumb-retry"
        title="Failed to load — click to retry"
        on:click|stopPropagation={retry}>⟳ Retry</button
      >
    {/if}
    {#if item.kind === "video"}
      {#if loaded}
        <span class="play-badge" aria-hidden="true">▶</span>
      {/if}
      {#if item.duration != null}
        <span class="duration-badge">{formatDuration(item.duration)}</span>
      {/if}
    {/if}
    {#if item.rating > 0}
      <span class="badge"><Stars rating={item.rating} /></span>
    {/if}
    {#if stackCount}
      <span class="stack-badge">×{stackCount}</span>
    {/if}
    {#if showSize && item.size != null}
      <!-- Size pill: bottom-right (as requested when sorting by size); shifts
           up above the ×N stack badge on a cover so they don't overlap. -->
      <span class="size-badge" class:with-stack={stackCount}
        >{formatSize(item.size)}</span
      >
    {/if}
    {#if inExpandedStack}
      <span
        class="stack-marker"
        class:is-cover={isCurrentCover}
        title={isCurrentCover
          ? "Current cover for this stack — press C to unset, Escape to collapse"
          : "Part of a burst — press C to make this the cover, Escape to collapse"}
        >⚏</span
      >
    {/if}
  </button>
</div>

<style>
  .thumb-wrap {
    position: absolute;
    transition:
      top 0.15s ease,
      left 0.15s ease,
      width 0.15s ease,
      height 0.15s ease;
  }
  .thumb {
    position: absolute;
    inset: 0;
    /* Keep the sticky-header band clear when scrollIntoView() reveals this
       tile (App.svelte's revealSelected). --reveal-margin is set on the
       scroll container = one header per grouping level + breathing room. */
    scroll-margin-top: var(--reveal-margin, 44px);
    /* Explicit z-index (not auto) so this element establishes its own
       stacking context: its own border/box-shadow (the selection
       highlight) and its children (cover z-index:50, badges z-index:100)
       all paint as one unit above the peek layers (z-index 1..
       MAX_PEEK_DEPTH, siblings in .thumb-wrap), regardless of DOM order.
       Without this, .thumb's own border/box-shadow — which has no
       z-index of its own — was promoted into .thumb-wrap's shared
       stacking context at the "auto" (effectively 0) level, below the
       peek layers' explicit positive z-index, and got visually
       painted over by them. */
    z-index: 10;
    padding: 0;
    border: 2px solid transparent;
    border-radius: 4px;
    overflow: hidden;
    background: #1a1a1a;
    cursor: pointer;
    outline: none;
  }
  /* The blue border means ONE thing: this is the focused tile — where the
     keyboard is. Selection membership is said by the gold checkmark alone.
     They used to share the border (focus blue, membership gold), which meant a
     tile that was both lost its focus ring to the gold: in a sea of selected
     photos you couldn't see where you were. One channel per idea. */
  .thumb.selected {
    border-color: #4c9aff;
    box-shadow: 0 0 0 2px rgba(76, 154, 255, 0.35);
  }
  .select-circle {
    position: absolute;
    top: 5px;
    right: 5px;
    z-index: 100;
    width: 20px;
    height: 20px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.4);
    border: 1.5px solid rgba(255, 255, 255, 0.9);
    color: #1a1400;
    border-radius: 50%;
    font-size: 0.72rem;
    font-weight: 700;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s;
  }
  /* Discoverable without cluttering a dense grid: the empty circle appears on
     hover and on the focused tile, and stays solid once the photo is selected. */
  .thumb:hover .select-circle,
  .thumb.selected .select-circle,
  .select-circle:focus-visible,
  .select-circle.on {
    opacity: 1;
  }
  .select-circle.on {
    background: #ffd24c;
    border-color: #ffd24c;
  }
  img.cover,
  .stack-peek {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .preview {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    border-radius: inherit;
    z-index: 1;
  }
  img.cover {
    /* inherit is correct here: img.cover is a child of .thumb, which
       has its own border-radius: 4px. */
    border-radius: inherit;
    z-index: 50;
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  img.cover.loaded {
    opacity: 1;
  }
  /* Cache hit (issue #41): the tile was already loaded before this mount, so
     drop the fade entirely — it should just be there, not animate back in. */
  img.cover.instant {
    transition: none;
  }
  .stack-peek {
    /* NOT `inherit`: .stack-peek is a sibling of .thumb, a direct child
       of .thumb-wrap (which has no border-radius of its own) — inherit
       would resolve to 0 here, not .thumb's 4px. Match .thumb's radius
       explicitly instead. */
    border-radius: 4px;
    filter: brightness(0.75);
    pointer-events: none;
  }
  .badge {
    position: absolute;
    left: 5px;
    bottom: 5px;
    pointer-events: none;
  }
  .stack-badge {
    position: absolute;
    right: 5px;
    bottom: 5px;
    padding: 1px 5px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    font-size: 0.7rem;
    border-radius: 3px;
    pointer-events: none;
  }
  .size-badge {
    position: absolute;
    right: 5px;
    bottom: 5px;
    padding: 1px 5px;
    background: rgba(0, 0, 0, 0.72);
    color: #fff;
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
    border-radius: 3px;
    pointer-events: none;
    z-index: 100;
  }
  .size-badge.with-stack {
    bottom: 26px; /* sit just above the ×N stack badge on a cover */
  }
  /* Centered play glyph marking a video tile (the still is its poster frame). */
  .play-badge {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.4rem;
    height: 2.4rem;
    padding-left: 3px; /* optically center the triangle */
    box-sizing: border-box;
    background: rgba(0, 0, 0, 0.5);
    color: #fff;
    font-size: 1rem;
    border-radius: 50%;
    pointer-events: none;
    z-index: 100;
  }
  /* Duration pill, bottom-LEFT so it never collides with the bottom-right
     stack "×N" badge on a video that is also a burst cover. */
  .duration-badge {
    position: absolute;
    left: 5px;
    bottom: 5px;
    padding: 1px 5px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
    border-radius: 3px;
    pointer-events: none;
    z-index: 100;
  }
  .stack-marker {
    position: absolute;
    left: 5px;
    top: 5px;
    padding: 1px 4px;
    background: rgba(76, 154, 255, 0.75);
    color: #06121f;
    font-size: 0.7rem;
    border-radius: 3px;
    pointer-events: none;
  }
  .stack-marker.is-cover {
    background: rgba(255, 196, 0, 0.85);
  }
  .badge,
  .stack-badge,
  .stack-marker {
    z-index: 100;
  }
  .thumb-spinner {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-top-color: rgba(255, 255, 255, 0.7);
    animation: thumb-spin 0.8s linear infinite;
    z-index: 60;
    pointer-events: none;
  }
  @keyframes thumb-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .thumb-retry {
    position: absolute;
    inset: 0;
    margin: auto;
    width: fit-content;
    height: fit-content;
    padding: 4px 8px;
    background: rgba(0, 0, 0, 0.75);
    color: #ff8a80;
    border: 1px solid rgba(255, 138, 128, 0.5);
    border-radius: 4px;
    font-size: 0.7rem;
    cursor: pointer;
    z-index: 60;
  }
  .thumb-retry:hover {
    background: rgba(0, 0, 0, 0.9);
  }
</style>
