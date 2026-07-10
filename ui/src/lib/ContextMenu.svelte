<script>
  // Generic right-click menu. Presentational and app-agnostic: it renders a
  // list of {label, action, enabled} items at (x, y), clamps itself inside the
  // viewport, and dismisses on click-away / Escape / scroll / blur / resize.
  //
  // This is intentionally the shared menu surface issue #25 (multi-select +
  // context menu) will grow — extend it by passing more `items`, don't rebuild.
  import { onMount, onDestroy, createEventDispatcher } from "svelte";

  export let x = 0;
  export let y = 0;
  /** @type {Array<{label: string, action: () => void, enabled?: boolean}>} */
  export let items = [];

  const dispatch = createEventDispatcher();

  let menuEl;
  let w = 0;
  let h = 0;
  const MARGIN = 6;

  // Clamp so the menu never spills past the right/bottom edge. Before the first
  // measurement w/h are 0, so it opens exactly at the cursor, then settles.
  $: left =
    typeof window !== "undefined"
      ? Math.max(MARGIN, Math.min(x, window.innerWidth - w - MARGIN))
      : x;
  $: top =
    typeof window !== "undefined"
      ? Math.max(MARGIN, Math.min(y, window.innerHeight - h - MARGIN))
      : y;

  function close() {
    dispatch("close");
  }

  function onItem(item) {
    if (item.enabled === false) return;
    item.action?.();
    close();
  }

  function onWindowMousedown(e) {
    // A click (mousedown) anywhere outside the menu dismisses it. Clicks inside
    // are handled by onItem, which closes after running the action.
    if (menuEl && !menuEl.contains(e.target)) close();
  }

  function onKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  onMount(() => {
    // Scroll must be captured: the grid scrolls an inner overflow container
    // whose scroll events don't bubble to window, so a bubbling listener would
    // miss them. Capture phase sees them all.
    window.addEventListener("scroll", close, true);
  });
  onDestroy(() => {
    window.removeEventListener("scroll", close, true);
  });
</script>

<svelte:window
  on:mousedown={onWindowMousedown}
  on:keydown={onKeydown}
  on:blur={close}
  on:resize={close}
/>

<div
  class="context-menu"
  role="menu"
  tabindex="-1"
  bind:this={menuEl}
  bind:clientWidth={w}
  bind:clientHeight={h}
  style="left:{left}px; top:{top}px;"
>
  {#each items as item}
    <button
      class="item"
      role="menuitem"
      disabled={item.enabled === false}
      on:click={() => onItem(item)}
    >
      {item.label}
    </button>
  {/each}
</div>

<style>
  .context-menu {
    position: fixed;
    z-index: 1000;
    min-width: 180px;
    padding: 4px;
    background: #1e1e1e;
    border: 1px solid #3a3a3a;
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 0.85rem;
    color: #e8e8e8;
    user-select: none;
  }
  .item {
    text-align: left;
    background: none;
    border: none;
    color: inherit;
    padding: 7px 10px;
    border-radius: 5px;
    cursor: pointer;
    font: inherit;
  }
  .item:hover:not(:disabled) {
    background: #3574f0;
    color: #fff;
  }
  .item:disabled {
    color: #666;
    cursor: default;
  }
</style>
