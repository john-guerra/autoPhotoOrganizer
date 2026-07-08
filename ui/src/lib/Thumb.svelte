<script context="module">
  export const PEEK_STEP_PX = 6; // px offset per peeking layer (diagonal: horizontal alternating + vertical), tuned for visibility
  export const MAX_PEEK_DEPTH = 2; // visual depth cap — peeks beyond this render at the same max offset, keeping the tile's footprint small and neat regardless of actual stack size
  export const PEEK_VERTICAL_PX = 2; // flat vertical offset for every peek layer (not scaled by depth) — a subtle "slightly offset" cue, kept tiny since it isn't reserved for in the grid layout
  export const STALL_MS = 12000; // an <img> load has no native timeout; treat a request that neither loads nor errors within this window as stalled
  export const PREVIEW_DELAY_MS = 150; // only fetch the embedded-preview fallback if the full thumbnail hasn't already loaded by then — avoids a wasted request on every already-cached (warm) view, where the full thumbnail resolves well under this delay
</script>

<script>
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { thumbUrl, previewUrl } from "./api.js";
  import Stars from "./Stars.svelte";

  const dispatch = createEventDispatcher();

  export let item; // {id, name, rating, mtimeMs}
  export let box; // {x, y, width, height} from the justified layout
  export let pad = 0; // grid frame inset (abs children ignore CSS padding)
  export let size = 640; // thumb longest edge; higher zoom requests sharper
  export let selected = false;
  export let stackCount = undefined; // set when this tile is a collapsed stack's cover
  export let inExpandedStack = false; // true when this photo is a member of a currently-expanded stack
  export let isCurrentCover = false; // true when this expanded member currently resolves as its stack's cover
  export let stackPeekItems = []; // this stack's other members (excludes the cover), for the peeking-photos visual
  export let stackMarginPx = 0; // horizontal margin reserved in the layout for this stack's peek layers (0 for non-stack tiles)

  let el;
  let visible = false; // set true once the tile nears the viewport
  let loaded = false;
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
      if (src === url && !loaded) previewSrc = previewUrl(item.id, item.mtimeMs);
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
  >
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
    {#if item.rating > 0}
      <span class="badge"><Stars rating={item.rating} /></span>
    {/if}
    {#if stackCount}
      <span class="stack-badge">×{stackCount}</span>
    {/if}
    {#if inExpandedStack}
      <span
        class="stack-marker"
        class:is-cover={isCurrentCover}
        title={isCurrentCover
          ? "Current cover for this stack — press C to unset, Escape to collapse"
          : "Part of a burst — press C to make this the cover, Escape to collapse"}>⚏</span
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
  .thumb.selected {
    border-color: #4c9aff;
    box-shadow: 0 0 0 2px rgba(76, 154, 255, 0.35);
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
