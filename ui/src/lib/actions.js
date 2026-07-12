/**
 * Svelte action: call `callback` when a pointerdown lands outside `node`.
 * Used to dismiss popovers/dropdowns. Uses capture so it fires before inner
 * handlers can stopPropagation.
 */
export function clickOutside(node, callback) {
  function onPointerDown(e) {
    if (!node.contains(e.target)) callback();
  }
  document.addEventListener("pointerdown", onPointerDown, true);
  return {
    destroy() {
      document.removeEventListener("pointerdown", onPointerDown, true);
    },
  };
}

/**
 * Svelte action: nudge an absolutely/fixed-positioned popover back inside the
 * viewport after it mounts, so a trigger near a screen edge can't push the
 * panel off-screen. Measures the node's rect and applies a corrective
 * `transform: translate(...)`; re-measures on window resize. Anchor-agnostic —
 * unlike ContextMenu's cursor-coord clamp, this works for panels positioned by
 * CSS (e.g. `right: 0`).
 */
export function clampToViewport(node, margin = 8) {
  function adjust() {
    node.style.transform = "";
    const r = node.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (r.right > window.innerWidth - margin)
      dx = window.innerWidth - margin - r.right;
    if (r.left + dx < margin) dx = margin - r.left;
    if (r.bottom > window.innerHeight - margin)
      dy = window.innerHeight - margin - r.bottom;
    if (r.top + dy < margin) dy = margin - r.top;
    node.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
  }
  adjust();
  window.addEventListener("resize", adjust);
  return {
    destroy() {
      window.removeEventListener("resize", adjust);
    },
  };
}

/** Svelte action: call `callback` when Escape is pressed while mounted. */
export function onEscape(node, callback) {
  function onKey(e) {
    if (e.key === "Escape") callback();
  }
  document.addEventListener("keydown", onKey);
  return {
    destroy() {
      document.removeEventListener("keydown", onKey);
    },
  };
}
