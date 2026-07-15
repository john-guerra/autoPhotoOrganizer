<script>
  // Generic right-click menu. Presentational and app-agnostic: it renders a
  // list of {label, action, enabled} items at (x, y), clamps itself inside the
  // viewport, and dismisses on click-away / Escape / scroll / blur / resize.
  //
  // This is intentionally the shared menu surface issue #25 (multi-select +
  // context menu) will grow — extend it by passing more `items`, don't rebuild.
  /**
   * @type {{
   *   x?: number,
   *   y?: number,
   *   items?: Array<{label?: string, action?: () => void, enabled?: boolean, danger?: boolean, separator?: boolean}>,
   *   onclose?: () => void,
   * }}
   * An item is either a row {label, action, enabled?, danger?} (`danger` styles a
   * destructive action) or a rule {separator:true}. Every action auto-dismisses
   * the menu (see onItem), so a two-click "arm the confirm" pattern cannot live
   * in here — a destructive item must confirm somewhere that outlives the menu
   * (the tree's Remove opens a Modal).
   */
  let { x = 0, y = 0, items = [], onclose } = $props();

  let menuEl;
  let w = $state(0);
  let h = $state(0);
  const MARGIN = 6;

  // Clamp so the menu never spills past the right/bottom edge. Before the first
  // measurement w/h are 0, so it opens exactly at the cursor, then settles.
  const left = $derived(
    typeof window !== "undefined"
      ? Math.max(MARGIN, Math.min(x, window.innerWidth - w - MARGIN))
      : x
  );
  const top = $derived(
    typeof window !== "undefined"
      ? Math.max(MARGIN, Math.min(y, window.innerHeight - h - MARGIN))
      : y
  );

  function close() {
    onclose?.();
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

  // Scroll must be captured: the grid scrolls an inner overflow container whose
  // scroll events don't bubble to window, so a bubbling listener would miss
  // them. Capture phase sees them all. (onMount/onDestroy → one $effect.)
  $effect(() => {
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  });
</script>

<svelte:window
  onmousedown={onWindowMousedown}
  onkeydown={onKeydown}
  onblur={close}
  onresize={close}
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
    {#if item.separator}
      <div class="sep" role="separator"></div>
    {:else}
      <button
        class="item"
        class:danger={item.danger}
        role="menuitem"
        disabled={item.enabled === false}
        onclick={() => onItem(item)}
      >
        {item.label}
      </button>
    {/if}
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
  /* Destructive items read as destructive BEFORE the click, not after. Same
     palette as the group header's Remove (GroupLabelActions), so one action
     looks the same wherever it is offered. */
  .item.danger {
    color: #ffb4b4;
  }
  .item.danger:hover:not(:disabled) {
    background: #7a2020;
    color: #fff;
  }
  /* Disabled ALWAYS wins the colour, danger included — a disabled item must never
     look clickable. `.item.danger` and `.item:disabled` have equal specificity,
     so without the compound `.item.danger:disabled` the later danger rule painted
     a disabled destructive item red (it looked enabled but the click was blocked).
     Listed last, and matching both plain and danger disabled, so it always wins. */
  .item:disabled,
  .item.danger:disabled {
    color: #666;
    cursor: not-allowed;
  }
  .sep {
    height: 1px;
    margin: 4px 6px;
    background: #3a3a3a;
  }
</style>
