<script>
  // Reusable modal built on the native <dialog> element. We rely on the
  // platform for the hard parts: top-layer rendering (no z-index), ::backdrop,
  // Esc-to-close (the `cancel` event), focus trapping, and focus restoration to
  // the invoker on close. Borrows Bootstrap's header/body/footer *structure*,
  // not its CSS.
  /**
   * @type {{
   *   open?: boolean,
   *   title?: string,
   *   size?: "sm" | "md" | "lg",
   *   dismissible?: boolean,
   *   onclose?: () => void,
   *   children?: import("svelte").Snippet,
   *   footer?: import("svelte").Snippet,
   * }}
   */
  let {
    open = $bindable(false),
    title = "",
    size = "md",
    dismissible = true,
    onclose,
    children,
    footer,
  } = $props();

  let dialogEl = $state();

  // Drive the imperative dialog API from the reactive `open` prop. Guard on the
  // dialog's real .open so we never double-call showModal()/close() (which would
  // throw or loop). A runes $effect tracks `open` and `dialogEl` precisely — none
  // of the safe_not_equal re-fire the old `$: if (dialogEl)` form was prone to.
  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) dialogEl.showModal();
    else if (!open && dialogEl.open) dialogEl.close();
  });

  function requestClose() {
    if (!dismissible) return;
    open = false; // keep bind:open in sync
    onclose?.();
  }

  // Native Esc fires `cancel`; preventDefault so WE own the close path (sets
  // open=false + dispatches), keeping the parent's state authoritative.
  function onCancel(e) {
    e.preventDefault();
    requestClose();
  }

  // Backdrop click: a click whose target is the <dialog> itself (not the inner
  // content wrapper) means the user clicked the ::backdrop area.
  function onDialogClick(e) {
    if (e.target === dialogEl) requestClose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
<!-- on:click only detects clicks on the ::backdrop (target === the <dialog>)
     to close; the keyboard close path is the native Esc → on:cancel below. -->
<dialog
  bind:this={dialogEl}
  class="modal size-{size}"
  oncancel={onCancel}
  onclick={onDialogClick}
  onclose={() => {
    if (open) requestClose();
  }}
  aria-label={title}
>
  <div class="modal-content">
    <header class="modal-header">
      <h2>{title}</h2>
      {#if dismissible}
        <button class="modal-close" title="Close (Esc)" onclick={requestClose}
          >✕</button
        >
      {/if}
    </header>
    <div class="modal-body">
      {@render children?.()}
    </div>
    {#if footer}
      <footer class="modal-footer">
        {@render footer()}
      </footer>
    {/if}
  </div>
</dialog>

<style>
  .modal {
    padding: 0;
    border: 1px solid #333;
    border-radius: 10px;
    background: #1e1e1e;
    color: #e8e8e8;
    max-height: 85vh;
    width: min(560px, 92vw);
  }
  .modal.size-sm {
    width: min(420px, 92vw);
  }
  .modal.size-lg {
    width: min(760px, 92vw);
  }
  .modal::backdrop {
    background: rgba(0, 0, 0, 0.55);
  }
  .modal-content {
    display: flex;
    flex-direction: column;
    max-height: 85vh;
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1.1rem;
    border-bottom: 1px solid #2a2a2a;
  }
  .modal-header h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .modal-close {
    background: none;
    border: none;
    color: #999;
    font-size: 1rem;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
  }
  .modal-close:hover {
    background: #2c2c2c;
    color: #fff;
  }
  .modal-body {
    padding: 1rem 1.1rem;
    overflow-y: auto;
  }
  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.75rem 1.1rem;
    border-top: 1px solid #2a2a2a;
  }
</style>
