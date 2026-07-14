<script>
  /**
   * Toolbar cluster ①: the add-a-folder popover (the single door — adding,
   * opening, and rescanning a folder are all the same act with different
   * options) plus a button that opens Manage folders. Purely presentational: it
   * owns the popover's open/close state and the form fields (two-way bound to
   * App, which owns the scan/scope logic) and emits `submit` when the user
   * commits.
   *
   * The primary button's verb adapts to the path, so it never lies about what
   * clicking it will do: "Add & scan" for a new folder, "Open" when the folder
   * is already indexed and the user wants to scope to it (NO scan — that's what
   * makes this work with the drive unmounted, since the index is an offline
   * mirror), "Rescan" when it's already indexed and they don't.
   */
  import { createEventDispatcher } from "svelte";
  import { clickOutside, onEscape } from "./actions.js";
  import { subtreeState } from "./subfolderSelection.js";
  import ToolGroup from "./ToolGroup.svelte";

  /** The ＋ menu (Add folder… / Manage library). Both doors, one handle. */
  let menuOpen = false;
  /** Escape / a click outside must close whichever of the two is showing —
   * closing only the panel left the menu hanging over the grid. */
  function closeAll() {
    menuOpen = false;
    addFolderOpen = false;
  }

  export let scanning = false;
  export let hasNativePicker = false;

  export let addFolderOpen = false;
  export let dir = "";
  export let recursiveScan = true;
  export let focusAfterAdd = false;
  /** True when `dir` is already a library member (App computes it). */
  export let alreadyIndexed = false;

  // The subfolder checklist. Collapsed by default: the common case (import
  // everything) stays one click and never waits on a directory walk of a big
  // card. App owns the state and the fetch; this renders it.
  export let subdirsOpen = false;
  export let subdirs = [];
  export let subdirsLoading = false;
  export let subdirsError = "";
  export let subdirSelection = new Set();

  const dispatch = createEventDispatcher();

  // A count only once a subset is actually in play — before the picker is
  // expanded nothing has been walked, so there's no honest number to show.
  $: chosenCount = subdirsOpen && subdirs.length ? subdirSelection.size : null;
  $: emptySelection = chosenCount === 0;
  $: verb = !alreadyIndexed
    ? chosenCount === null
      ? "Add & scan"
      : `Add & scan ${chosenCount} folder${chosenCount === 1 ? "" : "s"}`
    : focusAfterAdd
      ? "Open"
      : "Rescan";
  $: busyVerb = verb === "Open" ? "Opening…" : "Scanning…";
</script>

<ToolGroup label="Library">
  <div class="add-folder" use:clickOutside={closeAll} use:onEscape={closeAll}>
    <button
      class="add-toggle"
      on:click={() => (menuOpen = !menuOpen)}
      title="Add a folder, or manage the ones you already have"
      aria-label="Library"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
    >
      ＋
    </button>

    <!-- One door instead of two. The big blue "Folders" button spent a permanent
         120px of the toolbar on something you press once a week, and it sat next
         to a ＋ that did the other half of the same job. Both live behind the ＋
         now, named. -->
    {#if menuOpen}
      <div class="source-menu" role="menu">
        <button
          role="menuitem"
          on:click={() => {
            menuOpen = false;
            addFolderOpen = true;
          }}
        >
          Add folder…
        </button>
        <button
          role="menuitem"
          on:click={() => {
            menuOpen = false;
            dispatch("managelibrary");
          }}
        >
          Manage library
        </button>
      </div>
    {/if}

    {#if addFolderOpen}
      <div class="add-panel">
        <button
          class="popover-close"
          title="Close"
          aria-label="Close add folder"
          on:click={() => (addFolderOpen = false)}>✕</button
        >
        {#if hasNativePicker}
          <button
            class="choose-folder primary"
            on:click={() => dispatch("choosefolder")}
            disabled={scanning}
          >
            Choose folder…
          </button>
          <div class="add-or">or type a path</div>
        {/if}
        <div class="add-row">
          <input
            class="dir"
            type="text"
            placeholder="/path/to/photos"
            bind:value={dir}
            on:keydown={(e) =>
              e.key === "Enter" && !emptySelection && dispatch("submit")}
            spellcheck="false"
          />
          <button
            class="scan"
            on:click={() => dispatch("submit")}
            disabled={scanning || !dir.trim() || emptySelection}
          >
            {scanning ? busyVerb : verb}
          </button>
        </div>
        {#if emptySelection}
          <p class="err">Nothing selected — check at least one folder.</p>
        {/if}
        <label class="opt" title="Scan this folder and all folders inside it">
          <input type="checkbox" bind:checked={recursiveScan} />
          <span>Include subfolders</span>
        </label>
        {#if recursiveScan}
          {#if !subdirsOpen}
            <button
              class="link"
              disabled={!dir.trim()}
              on:click={() => {
                subdirsOpen = true;
                dispatch("loadsubdirs");
              }}
            >
              Choose subfolders…
            </button>
          {:else if subdirsLoading}
            <p class="hint">Reading folders…</p>
          {:else if subdirsError}
            <p class="err">{subdirsError}</p>
          {:else if subdirs.length === 0}
            <p class="hint">No folders with photos in here.</p>
          {:else}
            <ul class="subdirs">
              {#each subdirs as d (d.path)}
                {@const state = subtreeState(subdirSelection, d.path, subdirs)}
                <li style="padding-left: {d.depth * 14}px">
                  <label>
                    <!-- Checking a folder pulls in everything under it. When a
                         descendant is excluded the box goes indeterminate, so a
                         parent never shows a full tick over a partial import. -->
                    <input
                      type="checkbox"
                      checked={state === "all"}
                      indeterminate={state === "some"}
                      on:change={() => dispatch("toggledir", { path: d.path })}
                    />
                    <span class="name"
                      >{d.relPath.split("/").pop() || "(this folder)"}</span
                    >
                    <span class="count">{d.mediaCount.toLocaleString()}</span>
                  </label>
                </li>
              {/each}
            </ul>
            <div class="subdir-actions">
              <button class="link" on:click={() => dispatch("selectalldirs")}
                >All</button
              >
              <button class="link" on:click={() => dispatch("selectnodirs")}
                >None</button
              >
            </div>
          {/if}
        {/if}
        <label
          class="opt"
          title="Show only this folder — the rest of your library stays indexed, just out of view"
        >
          <input type="checkbox" bind:checked={focusAfterAdd} />
          <span>Focus on this folder only</span>
        </label>
        {#if alreadyIndexed && dir.trim()}
          <p class="hint">Already in your library.</p>
        {/if}
      </div>
    {/if}
  </div>
</ToolGroup>

<style>
  .source-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    min-width: 170px;
    padding: 4px;
    background: #161616;
    border: 1px solid #2f2f2f;
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }
  .source-menu button {
    text-align: left;
    background: transparent;
    border: none;
    color: #e6e6e6;
    font: inherit;
    padding: 6px 10px;
    border-radius: 5px;
    cursor: pointer;
    white-space: nowrap;
  }
  .source-menu button:hover {
    background: #2a2a2a;
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
  .add-toggle:hover {
    background: #1c1c1c;
  }
  .add-panel {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 50;
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 30px 10px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 300px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .popover-close {
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
  .popover-close:hover {
    background: #2c2c2c;
  }
  .add-row {
    display: flex;
    gap: 8px;
  }
  .choose-folder.primary {
    width: 100%;
    padding: 0.5rem 1rem;
  }
  .add-or {
    font-size: 0.72rem;
    color: #8a8a8a;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    color: #b8b8b8;
    cursor: pointer;
  }
  .hint {
    margin: 0;
    font-size: 0.75rem;
    color: #8a8a8a;
  }
  .err {
    margin: 0;
    font-size: 0.75rem;
    color: #ff8a80;
  }
  .link {
    align-self: flex-start;
    padding: 0;
    background: none;
    border: none;
    color: #4c9aff;
    font-size: 0.78rem;
    cursor: pointer;
    text-decoration: underline;
  }
  .link:disabled {
    color: #555;
    cursor: default;
    text-decoration: none;
  }
  .subdirs {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 220px;
    overflow-y: auto;
    border: 1px solid #262626;
    border-radius: 6px;
    background: #080808;
  }
  .subdirs li {
    padding: 2px 6px;
  }
  .subdirs label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.78rem;
    color: #cfcfcf;
    cursor: pointer;
  }
  .subdirs .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .subdirs .count {
    margin-left: auto;
    padding-left: 8px;
    color: #7a7a7a;
    font-variant-numeric: tabular-nums;
  }
  .subdir-actions {
    display: flex;
    gap: 10px;
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
  .scan,
  .choose-folder {
    padding: 0.45rem 1rem;
    background: #4c9aff;
    color: #06121f;
    border: none;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
  }
  .scan:disabled,
  .choose-folder:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
