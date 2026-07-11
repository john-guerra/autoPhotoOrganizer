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
