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
  import { createEventDispatcher } from "svelte";
  import { clickOutside, onEscape, clampToViewport } from "./actions.js";
  import { combo } from "./platform.js";

  export let selectedCount = 0;
  export let lastClearedSelection = null;
  export let hasNativePicker = false;
  export let exporting = false;
  export let exportResult = null;

  export let exportOpen = false;
  export let exportDest = "";
  export let exportName = "";
  export let exportMove = false;

  /** The pending ⌘A / ⌘⇧A question, if one is up. @type {null|"select"|"deselect"} */
  export let pendingBulk = null;
  /** How many photos the answer would touch (everything the filters show). */
  export let pendingCount = 0;
  /** A re-read job is in flight — the button says so instead of looking dead. */
  export let rereading = false;

  const dispatch = createEventDispatcher();
</script>

<!-- Stays up while there's a selection OR a clear still waiting to be undone.
     `selectedCount > 0` alone meant Clear removed the Undo button along with the
     selection, so the "undoable" clear had no way to be undone (#97).
     It also stays up for the ⌘A / ⌘⇧A question, which can be asked from an
     empty selection. -->
{#if selectedCount > 0 || lastClearedSelection || pendingBulk}
  <div class="cluster selection">
    <!-- The inline answer to "⌘A again": asking in the status bar rather than a
         blocking confirm() (#97 — the native dialog froze the whole UI). Press
         the shortcut again, click, or Escape. -->
    {#if pendingBulk}
      <span class="ask">
        <!-- Select names its count (it really will take that many). Deselect
             can't: only the shown photos that are ALSO selected get removed, and
             we don't know how many that is without fetching the ids. Quoting the
             shown-count here would promise a number the action won't deliver, so
             it stays unnumbered and the status line reports the true count after. -->
        {pendingBulk === "select"
          ? `Select all ${pendingCount.toLocaleString()} photos shown?`
          : "Remove everything shown from the selection?"}
      </span>
      <button
        class="sel-btn confirm"
        on:click={() => dispatch("bulkconfirm")}
        title={`${combo("A", { shift: pendingBulk === "deselect" })} again also confirms`}
        >{pendingBulk === "select" ? "Select all" : "Remove all"}</button
      >
      <button class="sel-btn" on:click={() => dispatch("bulkcancel")}>
        Cancel
      </button>
    {/if}
    {#if selectedCount > 0}
      <button
        class="sel-btn"
        on:click={() => dispatch("clear")}
        title="Clear selection">Clear</button
      >
      <button
        class="sel-btn"
        on:click={() => dispatch("keeponly")}
        title="Focus the whole app on just these photos (keep only)"
        >Keep only</button
      >
      <button
        class="sel-btn"
        disabled={rereading}
        on:click={() => dispatch("reread")}
        title="Read these photos' EXIF again from disk — dates, camera, lens, dimensions (use after editing the files elsewhere)"
        >{rereading ? "Re-reading…" : "Re-read metadata"}</button
      >
    {/if}
    {#if lastClearedSelection}
      <button
        class="sel-btn undo"
        on:click={() => dispatch("undoclear")}
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
          on:click={() => (exportOpen = !exportOpen)}
          title="Copy the selected photos into a new folder">Export…</button
        >
        {#if exportOpen}
          <div class="export-panel" use:clampToViewport>
            <button
              class="export-close"
              title="Close"
              aria-label="Close export"
              on:click={() => (exportOpen = false)}>✕</button
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
                    on:click={() => dispatch("choosedest")}
                  >
                    Choose…
                  </button>
                {/if}
              </div>
            </label>
            <label class="export-field">
              <span>New folder name</span>
              <input
                class="dir"
                type="text"
                placeholder="album-name"
                bind:value={exportName}
                spellcheck="false"
              />
            </label>
            <label
              class="export-move"
              title="Move the originals out of their current folder instead of copying them"
            >
              <input type="checkbox" bind:checked={exportMove} />
              <span>Move the files instead of copying</span>
            </label>
            {#if exportMove}
              <p class="export-warn" role="note">
                The originals will be <strong>moved out</strong> of their current
                folders. You can undo this from the jobs panel afterwards.
              </p>
            {/if}
            <div class="export-actions">
              <button
                class="scan"
                class:danger={exportMove}
                on:click={() => dispatch("export")}
                disabled={exporting || !exportDest.trim() || !exportName.trim()}
              >
                {exporting
                  ? exportMove
                    ? "Moving…"
                    : "Copying…"
                  : `${exportMove ? "Move" : "Copy"} ${selectedCount} photo${selectedCount === 1 ? "" : "s"}`}
              </button>
            </div>
            {#if exportResult}
              <p class="export-result">
                Copied {exportResult.copied}{exportResult.skipped
                  ? `, skipped ${exportResult.skipped}`
                  : ""} → {exportResult.target}
              </p>
            {/if}
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
  .ask {
    font-size: 0.8rem;
    color: #ffd24c;
    white-space: nowrap;
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
  }
  .export-move {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.78rem;
    color: #cfcfcf;
    cursor: pointer;
  }
  .export-warn {
    margin: 0;
    font-size: 0.75rem;
    color: #ffd24c;
    line-height: 1.35;
  }
  .scan.danger {
    background: #b3541e;
    color: #fff;
  }
  .export-result {
    margin: 0;
    font-size: 0.75rem;
    color: #8fd18f;
    word-break: break-all;
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
    padding: 0.45rem 1rem;
    background: #4c9aff;
    color: #06121f;
    border: none;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
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
