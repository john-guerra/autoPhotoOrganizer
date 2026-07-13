<script>
  import { createEventDispatcher } from "svelte";
  import {
    deleteFolder,
    fetchCacheStats,
    fetchCacheBreakdown,
    clearCache,
    pruneCache,
    resetLibrary,
  } from "./api.js";
  import Modal from "./Modal.svelte";

  export let library = [];
  /** Photos whose metadata has never been read, and whether a sweep is running. */
  export let pendingMeta = 0;
  export let sweeping = false;

  const dispatch = createEventDispatcher();

  let stats = null;
  let breakdown = null;
  let breakdownLoading = false;
  let busy = false;
  let message = "";
  // Danger zone: typing this exact word arms the full-reset button.
  const RESET_WORD = "DELETE";
  let resetConfirm = "";

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  async function loadStats() {
    stats = await fetchCacheStats().catch(() => null);
  }
  loadStats();

  async function showBreakdown() {
    breakdownLoading = true;
    breakdown = await fetchCacheBreakdown().catch(() => ({ folders: [] }));
    breakdownLoading = false;
  }

  async function removeFolder(entry) {
    if (
      !confirm(
        `Remove "${entry.name}" from the library? Real files on disk are not affected.`
      )
    ) {
      return;
    }
    busy = true;
    try {
      await deleteFolder(entry.id);
      dispatch("folderRemoved", { id: entry.id });
      message = `Removed "${entry.name}".`;
    } catch (e) {
      message = e.message;
    } finally {
      busy = false;
    }
  }

  async function doClearCache() {
    if (
      !confirm(
        "Clear the entire thumbnail cache? It will regenerate automatically as photos are viewed again."
      )
    ) {
      return;
    }
    busy = true;
    try {
      const result = await clearCache();
      message = `Cleared ${result.freedFiles} file(s), freed ${formatBytes(result.freedBytes)}.`;
      breakdown = null;
      await loadStats();
    } catch (e) {
      message = e.message;
    } finally {
      busy = false;
    }
  }

  async function doPruneCache() {
    busy = true;
    try {
      const result = await pruneCache();
      message = `Pruned ${result.freedFiles} orphaned file(s), freed ${formatBytes(result.freedBytes)}.`;
      breakdown = null;
      await loadStats();
    } catch (e) {
      message = e.message;
    } finally {
      busy = false;
    }
  }

  async function doResetLibrary() {
    if (resetConfirm !== RESET_WORD) return;
    busy = true;
    try {
      const result = await resetLibrary();
      message = `Library reset — removed ${result.folders} folder(s), ${result.photos} photo(s), and cleared the thumbnail cache. Photos on disk are untouched.`;
      resetConfirm = "";
      dispatch("libraryReset", result);
    } catch (e) {
      message = e.message;
    } finally {
      busy = false;
    }
  }
</script>

<Modal
  open={true}
  title="Manage library"
  size="md"
  on:close={() => dispatch("close")}
>
  {#if message}<p class="message">{message}</p>{/if}

  <section>
    <h3>Indexed folders</h3>
    {#if library.length === 0}
      <p class="empty">No folders scanned yet.</p>
    {/if}
    <ul class="folder-list">
      {#each library as entry (entry.id)}
        <li>
          <span class="folder-path" title={entry.path}>{entry.name}</span>
          {#if !entry.mounted}<span class="offline-badge">offline</span>{/if}
          <button
            class="remove-btn"
            disabled={busy}
            on:click={() => removeFolder(entry)}
          >
            Remove
          </button>
        </li>
      {/each}
    </ul>
  </section>

  <section>
    <h3>Thumbnail cache</h3>
    {#if stats}
      <p>{formatBytes(stats.totalBytes)} in {stats.totalFiles} file(s)</p>
    {:else}
      <p class="empty">Loading…</p>
    {/if}

    <div class="cache-actions">
      <button disabled={busy} on:click={showBreakdown}>
        {breakdownLoading ? "Computing…" : "Show breakdown"}
      </button>
      <button disabled={busy} on:click={doClearCache}>Clear cache</button>
      <button disabled={busy} on:click={doPruneCache}>Prune orphaned</button>
    </div>

    {#if breakdown}
      {#if breakdown.folders.length === 0}
        <p class="empty">No cached thumbnails attributed to any folder.</p>
      {:else}
        <ul class="breakdown-list">
          {#each breakdown.folders as f (f.id)}
            <li>
              <span class="folder-path" title={f.path}>{f.path}</span>
              <span>{formatBytes(f.cachedBytes)} ({f.cachedFiles} files)</span>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>

  <section>
    <h3>Photo metadata</h3>
    <p>
      AutoGallery reads a photo's date, camera and lens the first time it shows
      it to you. Photos you have never scrolled past have none yet — they group
      under <strong>Unknown</strong> and are missing from the timeline.
    </p>
    {#if pendingMeta > 0}
      <p>
        <strong>{pendingMeta.toLocaleString()}</strong> photos not read yet.
      </p>
      <div class="cache-actions">
        <button disabled={busy || sweeping} on:click={() => dispatch("sweep")}>
          {sweeping ? "Reading…" : "Read all metadata"}
        </button>
      </div>
      <p class="hint">
        Runs in the background — keep browsing, and cancel any time from the
        jobs panel. Stopping early loses nothing: it picks up where it left off.
      </p>
    {:else}
      <p class="empty">Every photo's metadata has been read.</p>
    {/if}
  </section>

  <section class="danger">
    <h3>Danger zone</h3>
    <p class="danger-warn">
      Resetting wipes the entire index — <strong
        >every rating and cover choice</strong
      >
      and the thumbnail cache. Your photos on disk are never touched, but the ratings
      live only here and cannot be recovered. Type
      <code>{RESET_WORD}</code> to confirm.
    </p>
    <div class="danger-actions">
      <input
        class="reset-confirm"
        type="text"
        placeholder={RESET_WORD}
        bind:value={resetConfirm}
        spellcheck="false"
        autocomplete="off"
      />
      <button
        class="reset-btn"
        disabled={busy || resetConfirm !== RESET_WORD}
        on:click={doResetLibrary}
      >
        Reset library
      </button>
    </div>
  </section>
</Modal>

<style>
  h3 {
    margin: 0.75rem 0 0.4rem;
    font-size: 0.95rem;
    color: #ccc;
  }
  .message {
    background: #2a2a2a;
    border-radius: 4px;
    padding: 0.4rem 0.6rem;
    font-size: 0.85rem;
  }
  .empty {
    color: #888;
    font-size: 0.85rem;
  }
  .hint {
    color: #888;
    font-size: 0.8rem;
    margin: 0.4rem 0 0;
  }
  .folder-list,
  .breakdown-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .folder-list {
    /* A real library can have hundreds of indexed folders — without its
       own scroll bound, the cache-management section below (breakdown,
       clear, prune) would sit past a near-endless scroll, matching the
       existing Library dropdown's own max-height convention. */
    max-height: 240px;
    overflow-y: auto;
  }
  .folder-list li,
  .breakdown-list li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid #2a2a2a;
  }
  .folder-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85rem;
  }
  .offline-badge {
    font-size: 0.7rem;
    color: #888;
  }
  .remove-btn,
  .cache-actions button {
    background: #333;
    color: inherit;
    border: none;
    border-radius: 4px;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .remove-btn:hover:not(:disabled),
  .cache-actions button:hover:not(:disabled) {
    background: #444;
  }
  .remove-btn:disabled,
  .cache-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .cache-actions {
    display: flex;
    gap: 0.5rem;
    margin: 0.4rem 0;
  }
  .breakdown-list li span:last-child {
    font-size: 0.8rem;
    color: #aaa;
  }
  .danger {
    border: 1px solid #5a2020;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin-top: 1rem;
    background: #1a0f0f;
  }
  .danger h3 {
    color: #ff8a80;
  }
  .danger-warn {
    font-size: 0.8rem;
    color: #c9a3a3;
    line-height: 1.4;
  }
  .danger-warn code {
    background: #2a1414;
    padding: 0 4px;
    border-radius: 3px;
    color: #ff8a80;
  }
  .danger-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .reset-confirm {
    flex: 1;
    background: #101010;
    border: 1px solid #5a2020;
    border-radius: 4px;
    color: inherit;
    padding: 0.3rem 0.5rem;
    font-size: 0.85rem;
  }
  .reset-btn {
    background: #7a1f1f;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.3rem 0.8rem;
    cursor: pointer;
    font-size: 0.8rem;
    white-space: nowrap;
  }
  .reset-btn:hover:not(:disabled) {
    background: #a02828;
  }
  .reset-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
