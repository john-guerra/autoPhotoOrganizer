<script>
  /**
   * Toolbar cluster ④: the selection action bar — Clear / Keep only / Undo and
   * the Export popover. Renders only when there's a live selection. The
   * selection itself and all export logic live in App; this emits an event per
   * action and two-way binds the export popover's open state + form fields.
   */
  import { createEventDispatcher } from "svelte";

  export let selectedCount = 0;
  export let lastClearedSelection = null;
  export let hasNativePicker = false;
  export let exporting = false;
  export let exportResult = null;

  export let exportOpen = false;
  export let exportDest = "";
  export let exportName = "";

  const dispatch = createEventDispatcher();
</script>

{#if selectedCount > 0}
  <div class="cluster selection">
    <button class="sel-btn" on:click={() => dispatch("clear")} title="Clear selection"
      >Clear</button
    >
    <button
      class="sel-btn"
      on:click={() => dispatch("keeponly")}
      title="Focus the whole app on just these photos (keep only)"
      >Keep only</button
    >
    {#if lastClearedSelection}
      <button
        class="sel-btn undo"
        on:click={() => dispatch("undoclear")}
        title="Restore the selection you just cleared">Undo</button
      >
    {/if}
    <div class="export-wrap">
      <button
        class="sel-btn export"
        on:click={() => (exportOpen = !exportOpen)}
        title="Copy the selected photos into a new folder">Export…</button
      >
      {#if exportOpen}
        <div class="export-panel">
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
                <button class="choose-folder" on:click={() => dispatch("choosedest")}>
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
          <div class="export-actions">
            <button
              class="scan"
              on:click={() => dispatch("export")}
              disabled={exporting || !exportDest.trim() || !exportName.trim()}
            >
              {exporting
                ? "Copying…"
                : `Copy ${selectedCount} photo${selectedCount === 1 ? "" : "s"}`}
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
