<script>
  /**
   * Toolbar cluster ①: the library dropdown ("Manage library…" + "Open a
   * folder…") and the add/scan-a-folder popover. Purely presentational — it
   * owns no scan/library logic, only the open/close popover state and form
   * fields (two-way bound), and emits an event when the user asks to scan, pick
   * a folder, manage the library, or open a folder to focus on it. The folder
   * LIST that used to live in this dropdown moved to the tree/fisheye sidebar.
   */
  import { createEventDispatcher } from "svelte";
  import { clickOutside, onEscape } from "./actions.js";

  export let scanning = false;
  export let hasNativePicker = false;

  // Two-way with the parent: popover visibility + the scan form fields live in
  // App (dir is persisted, manageLibraryOpen drives App's modal), so bind them.
  export let libraryOpen = false;
  export let manageLibraryOpen = false;
  export let addFolderOpen = false;
  export let dir = "";
  export let recursiveScan = true;

  // The "open a folder to focus on it" popover (a text-input fallback shown
  // when there's no native OS picker) lives here next to its "Open a folder…"
  // trigger. App owns the open/close + field state (bound, like `dir`) and the
  // actual open-folder logic (emitted as `openfolderfocus`) — same split as the
  // scan form.
  export let openFolderOpen = false;
  export let openFolderDir = "";

  const dispatch = createEventDispatcher();
</script>

<div class="cluster source">
  <div
    class="library"
    use:clickOutside={() => (libraryOpen = false)}
    use:onEscape={() => (libraryOpen = false)}
  >
    <button
      class="library-toggle"
      on:click={() => (libraryOpen = !libraryOpen)}
      title="Recently scanned folders"
    >
      Library ▾
    </button>
    {#if libraryOpen}
      <ul class="library-panel">
        <li>
          <button
            class="library-entry"
            on:click={() => {
              libraryOpen = false;
              manageLibraryOpen = true;
            }}
          >
            Manage library…
          </button>
        </li>
        <li>
          <button
            class="library-entry"
            on:click={() => {
              libraryOpen = false;
              dispatch("openfolder");
            }}
            title="Open a single folder and focus the whole app on it"
          >
            Open a folder…
          </button>
        </li>
      </ul>
    {/if}
    {#if openFolderOpen}
      <div class="open-folder-popover">
        <!-- svelte-ignore a11y-autofocus -->
        <input
          class="dir"
          type="text"
          placeholder="/path/to/folder"
          bind:value={openFolderDir}
          on:keydown={(e) => {
            if (e.key === "Enter") {
              openFolderOpen = false;
              dispatch("openfolderfocus");
            } else if (e.key === "Escape") {
              openFolderOpen = false;
            }
          }}
          spellcheck="false"
          autofocus
        />
        <div class="open-folder-actions">
          <button
            class="open-folder-go"
            on:click={() => {
              openFolderOpen = false;
              dispatch("openfolderfocus");
            }}
            disabled={scanning}
          >
            {scanning ? "Opening…" : "Open"}
          </button>
          <button
            class="open-folder-cancel"
            on:click={() => (openFolderOpen = false)}
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}
  </div>
  <div
    class="add-folder"
    use:clickOutside={() => (addFolderOpen = false)}
    use:onEscape={() => (addFolderOpen = false)}
  >
    <button
      class="add-toggle"
      on:click={() => (addFolderOpen = !addFolderOpen)}
      title="Add / scan a folder"
      aria-label="Add folder"
    >
      ＋
    </button>
    {#if addFolderOpen}
      <div class="add-panel">
        <input
          class="dir"
          type="text"
          placeholder="/path/to/photos"
          bind:value={dir}
          on:keydown={(e) => e.key === "Enter" && dispatch("scan")}
          spellcheck="false"
        />
        <label
          class="recursive-opt"
          title="Scan this folder and all folders inside it"
        >
          <input type="checkbox" bind:checked={recursiveScan} />
          <span>Include subfolders</span>
        </label>
        <div class="add-actions">
          <button
            class="scan"
            on:click={() => dispatch("scan")}
            disabled={scanning}
          >
            {scanning ? "Scanning…" : "Scan"}
          </button>
          {#if hasNativePicker}
            <button
              class="choose-folder"
              on:click={() => dispatch("choosefolder")}
              disabled={scanning}
            >
              Choose Folder…
            </button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .cluster {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
    flex-shrink: 0;
  }
  .library {
    position: relative;
  }
  .library-toggle {
    padding: 0.45rem 1rem;
    background: #4c9aff;
    color: #06121f;
    border: none;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
  }
  .library-toggle:hover {
    background: #5ba8ff;
  }
  .library-panel {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 200;
    margin: 4px 0 0;
    padding: 4px 0;
    min-width: 220px;
    max-height: 300px;
    overflow-y: auto;
    list-style: none;
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 4px;
  }
  .library-entry {
    display: block;
    width: 100%;
    padding: 6px 10px;
    text-align: left;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
  }
  .library-entry:hover:not(:disabled) {
    background: #2a2a2a;
  }
  .open-folder-popover {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 300;
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 10px;
    min-width: 300px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .open-folder-actions {
    display: flex;
    gap: 8px;
  }
  .open-folder-go {
    padding: 0.4rem 1rem;
    background: #4c9aff;
    color: #06121f;
    border: none;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
  }
  .open-folder-go:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .open-folder-cancel {
    padding: 0.4rem 1rem;
    background: #101010;
    border: 1px solid #333;
    color: #cfcfcf;
    border-radius: 6px;
    cursor: pointer;
  }
  .add-folder {
    position: relative;
  }
  .add-toggle {
    background: #101010;
    border: 1px solid #333;
    color: #cfcfcf;
    border-radius: 6px;
    padding: 3px 9px;
    font-size: 0.95rem;
    line-height: 1;
    cursor: pointer;
  }
  .add-panel {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 50;
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 260px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .add-actions {
    display: flex;
    gap: 8px;
  }
  .recursive-opt {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    color: #b8b8b8;
    cursor: pointer;
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
  .choose-folder:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
