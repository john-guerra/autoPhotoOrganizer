<script>
  /**
   * A pan/zoom scatter on canvas, with a lasso (#232).
   *
   * DELIBERATELY DOMAIN-FREE. It is handed parallel typed arrays and two
   * callbacks that turn an INDEX into a picture and a label; it never learns
   * what a point means. That is the whole seam that makes #165's photo
   * scatter an entry plus a component rather than a rewrite — and it is
   * enforced by a structural test over this directory, not by intent.
   *
   * Canvas rather than SVG for the reason AlbumTimeline records: this repo's
   * working sets are tens of thousands of points, and that many DOM nodes
   * re-created on every transform change janks. All the arithmetic lives in
   * the pure modules beside this file, so hover, lasso and draw cannot
   * disagree about where a point is.
   */
  import { onMount, untrack } from "svelte";
  import {
    toScreen,
    toData,
    fitExtent,
    zoomAbout,
    clampZoom,
  } from "./transform.js";
  import { buildIndex, nearest } from "./hit.js";
  import { caught, simplify } from "./lasso.js";
  import {
    shouldDrawImages,
    imageSide,
    dotRadius,
    IMAGE_CACHE_MAX,
  } from "./lod.js";

  let {
    /** Parallel typed arrays. Never an array of objects: #165's 64,026 photo
     *  points would otherwise be 64,026 JS objects for the GC to walk. */
    points = { x: null, y: null, ids: null, size: null, group: null },
    width = 0,
    height = 0,
    /** `(index) => url | null`. null draws a dot only. */
    imageFor = () => null,
    /** `(index) => string` for the hover tooltip. */
    labelFor = () => "",
    /** INDICES to ring. */
    highlighted = new Set(),
    /** `(indices, {shift, alt}) => void` — indices, never ids. */
    onlasso,
    /** `(index) => void`, -1 for nothing (hitAt's convention). */
    onhover,
    /** `(index, event) => void` */
    onpick,
    /** `{k, tx, ty}`; the parent owns reset and zoom-to-fit. */
    transform = $bindable(),
  } = $props();

  let host = $state(null);
  let pointsCanvas = $state(null);
  let overlayCanvas = $state(null);

  let hovered = $state(-1);
  let lassoPath = [];
  let dragging = $state(false);
  let panning = false;
  let panFrom = null;
  let tip = $state(null);

  const n = $derived(points?.ids?.length ?? 0);

  /**
   * The spatial index, rebuilt only when the DATA changes — keyed on the id
   * array's identity, not on the transform. Rebuilding on every pan would
   * throw away a quadtree 60 times a second.
   */
  let index = null;
  let indexedIds = null;
  function ensureIndex() {
    if (!n) {
      index = null;
      indexedIds = null;
      return;
    }
    if (indexedIds !== points.ids) {
      index = buildIndex(points.x, points.y);
      indexedIds = points.ids;
    }
  }

  // --- the image cache -----------------------------------------------------
  //
  // LOD means a crop is only wanted once a point occupies enough screen space
  // to be recognisable, and at that zoom only a few hundred points are on
  // screen at all — so this never approaches the size of the map.
  const imgCache = new Map(); // url -> HTMLImageElement
  const inFlight = new Set();
  /** URLs that 404'd. A cover face can outlive its photo, and without this
   *  every draw re-requests every broken crop forever. */
  const failed = new Set();

  function imageAt(url) {
    if (!url) return null;
    const hit = imgCache.get(url);
    if (hit) {
      // Refresh LRU position.
      imgCache.delete(url);
      imgCache.set(url, hit);
      return hit.complete && hit.naturalWidth > 0 ? hit : null;
    }
    if (failed.has(url) || inFlight.has(url)) return null;
    inFlight.add(url);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      inFlight.delete(url);
      imgCache.set(url, img);
      // Never evict below what is currently on screen. Evicting a VISIBLE
      // crop makes the next draw request it again, whose load schedules
      // another draw, which evicts another visible one — a treadmill of
      // loading and repainting that looks exactly like the map blinking.
      const floor = Math.max(IMAGE_CACHE_MAX, visibleImageCount + 32);
      while (imgCache.size > floor) {
        imgCache.delete(imgCache.keys().next().value);
      }
      scheduleImageDraw();
    };
    // A failed load must not retry forever, and must not leave a hole: the dot
    // underneath is always drawn, so the point stays visible and clickable.
    img.onerror = () => {
      inFlight.delete(url);
      failed.add(url);
    };
    img.src = url;
    return null;
  }

  // --- drawing -------------------------------------------------------------
  //
  // Driven imperatively from the handlers rather than from an $effect that
  // reads and writes `transform`. AlbumTimeline documents that failure: an
  // effect writing the same $state it reads re-fires on its own write, because
  // each assignment re-proxies to a fresh reference — effect_update_depth_-
  // exceeded, and the tab locks up hard.
  /** How many crops the last draw actually wanted. Bounds cache eviction. */
  let visibleImageCount = 0;

  let frame = 0;
  function scheduleDraw() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  /**
   * A redraw caused by an IMAGE finishing, coalesced hard.
   *
   * Each crop that arrives would otherwise schedule a full clear-and-repaint
   * of every point — and hundreds arrive over a few seconds when you zoom into
   * a dense region. At interactive framerates that is a canvas being wiped and
   * rebuilt continuously, which is what "the map is blinking" looks like.
   * Nothing is moving; it is redrawing far more often than the picture
   * actually changes.
   *
   * Interaction still goes through `scheduleDraw` and stays at full frame
   * rate. This path is only for "one more face turned up", where a tenth of a
   * second of latency is invisible and 50 fewer repaints per second is not.
   */
  let imageFrame = 0;
  const IMAGE_COALESCE_MS = 100;
  function scheduleImageDraw() {
    if (imageFrame) return;
    imageFrame = setTimeout(() => {
      imageFrame = 0;
      scheduleDraw();
    }, IMAGE_COALESCE_MS);
  }

  function sizeCanvas(c) {
    // A canvas sized 0 throws, and both dimensions are 0 for a frame before
    // layout settles — an uncaught error there would fail trackPageErrors.
    if (!c || width <= 0 || height <= 0) return null;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function draw() {
    const ctx = sizeCanvas(pointsCanvas);
    if (!ctx || !n || !transform) return;
    ensureIndex();

    ctx.clearRect(0, 0, width, height);
    const t = transform;
    const drawImages = shouldDrawImages(t.k);
    const side = imageSide(t.k);

    // TWO PASSES, and the reason is visible the moment you zoom in: drawing a
    // dot and then its image per point means point 500's DOT lands on top of
    // point 3's crop, so a dense region renders as faces speckled with blue.
    // Dots first, images second, so a picture is never obscured by a
    // neighbour's marker.
    const drawn = [];
    for (let i = 0; i < n; i++) {
      const [px, py] = toScreen(points.x[i], points.y[i], t);
      // Cull generously: an image is drawn centred, so allow for its half-side.
      if (px < -side || py < -side || px > width + side || py > height + side) {
        continue;
      }
      const w = points.size ? points.size[i] : 1;
      const r = dotRadius(w, t.k);

      // The dot is always drawn. An unloaded crop is then a dot rather than a
      // hole, so the map never looks broken mid-load.
      ctx.fillStyle = points.group?.[i] ? "#2e8b57" : "#4c9aff";
      if (r <= 3) {
        // Several times cheaper than arc() and visually identical this small.
        ctx.fillRect(px - r, py - r, r * 2, r * 2);
      } else {
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (drawImages) drawn.push(i, px, py);
    }

    visibleImageCount = drawn.length / 3;
    for (let k = 0; k < drawn.length; k += 3) {
      const img = imageAt(imageFor(drawn[k]));
      if (!img) continue;
      const px = drawn[k + 1];
      const py = drawn[k + 2];
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, side / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, px - side / 2, py - side / 2, side, side);
      ctx.restore();
      // A thin ring so adjacent faces read as separate people rather than a
      // collage.
      ctx.strokeStyle = points.group?.[drawn[k]] ? "#2e8b57" : "#00000088";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, side / 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    drawOverlay();
  }

  function drawOverlay() {
    const ctx = sizeCanvas(overlayCanvas);
    if (!ctx || !transform) return;
    ctx.clearRect(0, 0, width, height);
    const t = transform;

    // Rings for the current selection.
    if (highlighted?.size) {
      ctx.strokeStyle = "#ffd166";
      ctx.lineWidth = 2;
      for (const i of highlighted) {
        if (i < 0 || i >= n) continue;
        const [px, py] = toScreen(points.x[i], points.y[i], t);
        if (px < -20 || py < -20 || px > width + 20 || py > height + 20)
          continue;
        const r = Math.max(
          5,
          dotRadius(points.size ? points.size[i] : 1, t.k) + 3
        );
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    if (hovered >= 0 && hovered < n) {
      const [px, py] = toScreen(points.x[hovered], points.y[hovered], t);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(6, imageSide(t.k) / 2 + 3), 0, Math.PI * 2);
      ctx.stroke();
    }

    if (lassoPath.length > 1) {
      ctx.strokeStyle = "#ffd166";
      ctx.fillStyle = "rgba(255, 209, 102, 0.12)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(lassoPath[0][0], lassoPath[0][1]);
      for (let i = 1; i < lassoPath.length; i++) {
        ctx.lineTo(lassoPath[i][0], lassoPath[i][1]);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  /**
   * Fit when a NEW MAP arrives — not when the array object changes identity.
   *
   * Two failures this sits between. Without any fit, the only one is on first
   * resize, which happens while the point set is still empty: `transform`
   * stays at k=1 and every dot renders in the top-left corner. But keying it
   * on `points.ids` IDENTITY is just as wrong in the other direction — the
   * parent rebuilds those typed arrays on any re-render, and Svelte reports
   * every object as changed even when it is the identical object (CLAUDE.md's
   * `safe_not_equal` trap). So an unrelated prop update would silently throw
   * away the user's zoom and pan, which reads as the map blinking.
   *
   * Keyed on the point COUNT and the first/last id instead: cheap, and it
   * changes exactly when the map's contents do — including after a merge,
   * which is when a re-fit is genuinely wanted.
   *
   * Reads `points`, writes `transform`, and must NEVER read `transform` or it
   * re-fires on its own write forever (AlbumTimeline's
   * effect_update_depth_exceeded).
   */
  let fittedKey = null;
  $effect(() => {
    const ids = points?.ids ?? null;
    if (!ids?.length || width <= 0 || height <= 0) return;
    const key = `${ids.length}:${ids[0]}:${ids[ids.length - 1]}`;
    if (key === fittedKey) return;
    fittedKey = key;
    untrack(() => fit());
  });

  // Redraw when the DATA or the viewport changes. Reads `transform` but never
  // writes it, so this cannot re-trigger itself.
  $effect(() => {
    points;
    width;
    height;
    transform;
    highlighted;
    hovered;
    if (width > 0 && height > 0) scheduleDraw();
  });

  // --- interaction ---------------------------------------------------------

  function localPoint(e) {
    const r = host.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    host.setPointerCapture(e.pointerId);
    const [px, py] = localPoint(e);
    // Space or the middle-ish modifier pans; a plain drag lassoes. Panning is
    // also available on any drag that starts with the meta key held.
    if (e.metaKey || e.ctrlKey) {
      panning = true;
      panFrom = [px, py, transform.tx, transform.ty];
      return;
    }
    dragging = true;
    lassoPath = [[px, py]];
  }

  function onPointerMove(e) {
    const [px, py] = localPoint(e);

    if (panning && panFrom) {
      transform = {
        ...transform,
        tx: panFrom[2] + (px - panFrom[0]),
        ty: panFrom[3] + (py - panFrom[1]),
      };
      return;
    }

    if (dragging) {
      lassoPath.push([px, py]);
      scheduleDraw();
      return;
    }

    ensureIndex();
    if (!index) return;
    const [dx, dy] = toData(px, py, transform);
    // Hit radius in DATA units, derived from a constant screen radius, so the
    // target stays the same physical size at every zoom.
    const hit = nearest(index, dx, dy, 14 / transform.k);
    if (hit !== hovered) {
      hovered = hit;
      onhover?.(hit);
      tip = hit >= 0 ? { x: px, y: py, text: labelFor(hit) } : null;
    } else if (hit >= 0 && tip) {
      tip = { x: px, y: py, text: tip.text };
    }
  }

  function onPointerUp(e) {
    if (host.hasPointerCapture?.(e.pointerId)) {
      host.releasePointerCapture(e.pointerId);
    }
    if (panning) {
      panning = false;
      panFrom = null;
      return;
    }
    if (!dragging) return;
    dragging = false;

    const path = simplify(lassoPath, 2);
    lassoPath = [];

    // A tap, not a drag: treat it as a pick so a click on a dot still works.
    if (path.length < 3) {
      ensureIndex();
      const [px, py] = localPoint(e);
      const [dx, dy] = toData(px, py, transform);
      const hit = index ? nearest(index, dx, dy, 14 / transform.k) : -1;
      if (hit >= 0) onpick?.(hit, e);
      scheduleDraw();
      return;
    }

    // Convert to DATA space once, here. Doing it per-move would let a pan
    // mid-drag shift what was caught.
    const dataPoly = path.map(([px, py]) => toData(px, py, transform));
    ensureIndex();
    const hits = index ? caught(index, dataPoly) : [];
    onlasso?.(hits, { shift: e.shiftKey, alt: e.altKey });
    scheduleDraw();
  }

  function onWheel(e) {
    // The view lives inside App's scrolling .main-column. Without this the
    // column scrolls while you try to zoom — this is the first view to declare
    // navigation: "zoom", so nothing else has had to do it.
    e.preventDefault();
    const [px, py] = localPoint(e);
    const factor = Math.exp(-e.deltaY * 0.002);
    transform = zoomAbout(transform, factor, px, py);
  }

  /** Fit every point into the viewport. The parent calls this via `bind:`. */
  export function fit() {
    if (!n || width <= 0 || height <= 0) return;
    transform = fitExtent(points.x, points.y, width, height, 32);
  }

  onMount(() => {
    // Deferred a frame: re-laying out synchronously inside a ResizeObserver
    // callback raises "ResizeObserver loop completed with undelivered
    // notifications", an uncaught error that (rightly) fails trackPageErrors.
    // ToolbarRow.svelte does the same.
    let pending = 0;
    const ro = new ResizeObserver((entries) => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        const box = entries[0]?.contentRect;
        if (!box) return;
        // Sub-pixel jitter is real (a scrollbar appearing elsewhere, a
        // fractional layout) and writing `width` on every report re-runs the
        // draw effect for no visible change. Ignore anything under a pixel.
        if (
          Math.abs(box.width - width) < 1 &&
          Math.abs(box.height - height) < 1
        ) {
          return;
        }
        const first = width === 0 || height === 0;
        width = box.width;
        height = box.height;
        if (first) untrack(() => fit());
        else scheduleDraw();
      });
    });
    if (host) ro.observe(host);
    return () => {
      ro.disconnect();
      if (pending) cancelAnimationFrame(pending);
      if (frame) cancelAnimationFrame(frame);
      if (imageFrame) clearTimeout(imageFrame);
    };
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="scatter"
  bind:this={host}
  data-testid="scatter"
  role="application"
  aria-label="Scatter plot. Drag to lasso, hold Command and drag to pan, scroll to zoom."
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  onwheel={onWheel}
>
  <!-- No inline width/height: `inset: 0` already sizes these, and writing a
       px size here during a ResizeObserver callback feeds straight back into
       layout — "ResizeObserver loop completed with undelivered notifications",
       an uncaught error that (rightly) fails trackPageErrors. Only the BACKING
       STORE is set, in JS, from sizeCanvas(). -->
  <canvas bind:this={pointsCanvas}></canvas>
  <canvas class="overlay" bind:this={overlayCanvas}></canvas>

  {#if tip && !dragging}
    <div
      class="tip"
      style="left:{Math.min(
        tip.x + 14,
        Math.max(0, width - 220)
      )}px;top:{tip.y + 14}px"
    >
      {tip.text}
    </div>
  {/if}
</div>

<style>
  .scatter {
    position: relative;
    width: 100%;
    height: 100%;
    /* This view owns its viewport (navigation: "zoom"), so it must not hand
       scrolling back to App's .main-column. */
    overflow: hidden;
    touch-action: none;
    cursor: crosshair;
    background: #101010;
  }
  canvas {
    position: absolute;
    inset: 0;
    display: block;
    /* The element is sized by inset; the backing store is sized in JS at
       devicePixelRatio. Without this the store's pixel size would also become
       the layout size. */
    width: 100%;
    height: 100%;
  }
  .overlay {
    pointer-events: none;
  }
  .tip {
    position: absolute;
    pointer-events: none;
    background: #000c;
    border: 1px solid #333;
    color: #eee;
    font-size: 0.78rem;
    padding: 3px 7px;
    border-radius: 4px;
    max-width: 220px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
