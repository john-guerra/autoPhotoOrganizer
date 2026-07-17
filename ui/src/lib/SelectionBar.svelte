<script>
  /**
   * Toolbar cluster ④: the selection action bar — Clear / Keep only / Undo and
   * the Export popover.
   *
   * Visible while there's a live selection, and ALSO while a cleared selection is
   * still waiting to be undone — otherwise Clear takes the Undo button away with
   * the selection and the "undoable" clear can't be undone (#97). The actions
   * that need a selection (Clear / Keep only / Export) hide when it's empty; Undo
   * is the one thing that outlives it.
   *
   * The selection itself and all export logic live in App; this emits an event
   * per action and two-way binds the export popover's open state + form fields.
   */
  import { clickOutside, onEscape, clampToViewport } from "./actions.js";
  import { combo } from "./platform.js";
  import Modal from "./Modal.svelte";

  let {
    selectedCount = 0,
    lastClearedSelection = null,
    hasNativePicker = false,
    exporting = false,
    exportResult = null,

    exportOpen = $bindable(false),
    exportDest = $bindable(""),
    // Which mode is in flight, so the right button shows its spinner label. Set
    // by whichever button (Copy/Move) launched the export. Not persisted.
    exportMove = $bindable(false),

    /** The pending ⌘A / ⌘⇧A question, if one is up. @type {null|"select"|"deselect"} */
    pendingBulk = null,
    /** How many photos the answer would touch (everything the filters show). */
    pendingCount = 0,
    /** The pending "select this whole folder?" question — clicking a group's
     * select-all when the group is very large. Same inline surface as ⌘A's, for the
     * same reason: a blocking confirm() froze the whole UI (#97).
     * @type {null|{count: number, label: string}} */
    pendingGroup = null,
    /** A re-read job is in flight — the button says so instead of looking dead. */
    rereading = false,

    onbulkconfirm,
    onbulkcancel,
    ongroupconfirm,
    ongroupcancel,
    onclear,
    onkeeponly,
    onreread,
    onundoclear,
    onchoosedest,
    onexport,
  } = $props();
</script>

<!-- The ⌘A / ⌘⇧A and per-folder select-all questions are MODALS (below), not
     inline: the status-bar prompt was too easy to miss. They can be asked from
     an empty selection, so they live outside the bar's own visibility gate. -->
{#if pendingBulk}
  <Modal
    open={true}
    title={pendingBulk === "select"
      ? "Select all photos?"
      : "Remove from selection?"}
    size="sm"
    onclose={() => onbulkcancel?.()}
  >
    <p class="confirm-body">
      <!-- Select names its count (it really will take that many). Deselect
           can't: only the shown photos that are ALSO selected get removed, and
           we don't know how many that is without fetching the ids. Quoting the
           shown-count here would promise a number the action won't deliver, so
           it stays unnumbered and the status line reports the true count after. -->
      {pendingBulk === "select"
        ? `Select all ${pendingCount.toLocaleString()} photos shown?`
        : "Remove everything shown from the selection?"}
    </p>
    {#snippet footer()}
      <button class="sel-btn" onclick={() => onbulkcancel?.()}>Cancel</button>
      <button
        class="sel-btn confirm"
        onclick={() => onbulkconfirm?.()}
        title={`${combo("A", { shift: pendingBulk === "deselect" })} again also confirms`}
        >{pendingBulk === "select" ? "Select all" : "Remove all"}</button
      >
    {/snippet}
  </Modal>
{/if}
<!-- The same question, asked of one folder instead of the whole view. It
     names the folder, because "select all 12,431 photos?" without saying
     WHERE is not something anyone can answer. -->
{#if pendingGroup}
  <Modal
    open={true}
    title="Select all photos in this folder?"
    size="sm"
    onclose={() => ongroupcancel?.()}
  >
    <p class="confirm-body">
      Select all {pendingGroup.count.toLocaleString()} photos in {pendingGroup.label}?
    </p>
    {#snippet footer()}
      <button class="sel-btn" onclick={() => ongroupcancel?.()}>Cancel</button>
      <button
        class="sel-btn confirm"
        onclick={() => ongroupconfirm?.()}
        title="Select every photo in this folder and the folders under it"
        >Select all</button
      >
    {/snippet}
  </Modal>
{/if}

<!-- Stays up while there's a selection OR a clear still waiting to be undone.
     `selectedCount > 0` alone meant Clear removed the Undo button along with the
     selection, so the "undoable" clear had no way to be undone (#97). -->
{#if selectedCount > 0 || lastClearedSelection}
  <div class="cluster selection">
    {#if selectedCount > 0}
      <button
        class="sel-btn"
        onclick={() => onclear?.()}
        title="Clear selection">Clear</button
      >
      <button
        class="sel-btn"
        onclick={() => onkeeponly?.()}
        title="Focus the whole app on just these photos (keep only)"
        >Keep only</button
      >
      <button
        class="sel-btn"
        disabled={rereading}
        onclick={() => onreread?.()}
        title="Read these photos' EXIF again from disk — dates, camera, lens, dimensions (use after editing the files elsewhere)"
        >{rereading ? "Re-reading…" : "Re-read metadata"}</button
      >
    {/if}
    {#if lastClearedSelection}
      <button
        class="sel-btn undo"
        onclick={() => onundoclear?.()}
        title="Put the selection back exactly as it was before the last bulk change (Clear, ⌘A, ⌘⇧A)"
        >Undo</button
      >
    {/if}
    {#if selectedCount > 0}
      <div
        class="export-wrap"
        use:clickOutside={() => (exportOpen = false)}
        use:onEscape={() => (exportOpen = false)}
      >
        <button
          class="sel-btn export"
          onclick={() => (exportOpen = !exportOpen)}
          title="Copy the selected photos into a new folder">Export…</button
        >
        {#if exportOpen}
          <div class="export-panel" use:clampToViewport>
            <button
              class="export-close"
              title="Close"
              aria-label="Close export"
              onclick={() => (exportOpen = false)}>✕</button
            >
            <label class="export-field">
              <span>Destination folder</span>
              <div class="export-row">
                <input
                  class="dir"
                  type="text"
                  placeholder="/path/to/destination"
                  bind:value={exportDest}
                  spellcheck="false"
                />
                {#if hasNativePicker}
                  <button
                    class="choose-folder"
                    onclick={() => onchoosedest?.()}
                    title="Pick or create the destination folder"
                  >
                    Choose…
                  </button>
                {/if}
              </div>
              <span class="export-hint">
                Files go straight into this folder.
                {#if hasNativePicker}
                  Use <strong>Choose…</strong> to make a new one.
                {:else}
                  Type the path of an existing folder.
                {/if}
              </span>
            </label>
            <!-- Two buttons, not a checkbox: Move is destructive (it relocates
                 the originals), so it wears its own warm colour and never hides
                 behind a toggle you might not notice. Both launch the same
                 audited, undoable job — Move just passes move=true. -->
            <div class="export-actions">
              <button
                class="scan copy"
                onclick={() => onexport?.(false)}
                disabled={exporting || !exportDest.trim()}
              >
                {exporting && !exportMove
                  ? "Copying…"
                  : `Copy ${selectedCount} photo${selectedCount === 1 ? "" : "s"}`}
              </button>
              <button
                class="scan move"
                onclick={() => onexport?.(true)}
                disabled={exporting || !exportDest.trim()}
                title="Move the originals out of their current folders (undoable from the jobs panel)"
              >
                {exporting && exportMove
                  ? "Moving…"
                  : `Move ${selectedCount} photo${selectedCount === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .cluster {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
    flex-shrink: 0;
  }
  .cluster.selection {
    gap: 6px;
  }
  .sel-btn {
    background: #222;
    border: 1px solid #3a3a3a;
    color: #e8e8e8;
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .sel-btn:hover {
    background: #2c2c2c;
  }
  .sel-btn.export {
    background: #4c9aff;
    border-color: #4c9aff;
    color: #06121f;
    font-weight: 600;
  }
  .sel-btn.undo {
    color: #ffd24c;
  }
  .sel-btn.confirm {
    background: #4c9aff;
    border-color: #4c9aff;
    color: #06121f;
    font-weight: 600;
  }
  .confirm-body {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.45;
    color: #e8e8e8;
  }
  .export-wrap {
    position: relative;
  }
  .export-panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 50;
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 300px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .export-close {
    position: absolute;
    top: 6px;
    right: 8px;
    width: 22px;
    height: 22px;
    padding: 0;
    line-height: 1;
    background: transparent;
    border: 1px solid #444;
    color: #cfcfcf;
    border-radius: 50%;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .export-close:hover {
    background: #2c2c2c;
  }
  .export-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.75rem;
    color: #9a9a9a;
  }
  .export-row {
    display: flex;
    gap: 8px;
  }
  .export-actions {
    display: flex;
    gap: 8px;
  }
  .export-hint {
    font-size: 0.72rem;
    color: #7a7a7a;
    line-height: 1.35;
  }
  .export-hint strong {
    color: #9a9a9a;
  }
  .dir {
    flex: 1;
    max-width: 40rem;
    padding: 0.45rem 0.6rem;
    background: #101010;
    border: 1px solid #333;
    border-radius: 6px;
    color: #eee;
    font-size: 0.9rem;
    font-family: ui-monospace, monospace;
  }
  .dir:focus {
    outline: none;
    border-color: #4c9aff;
  }
  .scan {
    flex: 1;
    padding: 0.45rem 1rem;
    border: none;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  /* Copy is the safe default (blue); Move is destructive and wears a warm
     colour so it never reads as "the same button, other label". */
  .scan.copy {
    background: #4c9aff;
    color: #06121f;
  }
  .scan.move {
    background: #d2691e;
    color: #fff;
  }
  .scan:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .choose-folder {
    padding: 0.45rem 1rem;
    background: #4c9aff;
    color: #06121f;
    border: none;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
  }
</style>
