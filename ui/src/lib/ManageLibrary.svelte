<script>
  import { createEventDispatcher } from "svelte";
  import {
    deleteFolder,
    fetchCacheStats,
    fetchCacheBreakdown,
    clearCache,
    pruneCache,
  } from "./api.js";

  export let library = [];

  const dispatch = createEventDispatcher();

  let stats = null;
  let breakdown = null;
  let breakdownLoading = false;
  let busy = false;
  let message = "";

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
    if (!confirm(`Remove "${entry.name}" from the library? Real files on disk are not affected.`)) {
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
    if (!confirm("Clear the entire thumbnail cache? It will regenerate automatically as photos are viewed again.")) {
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
</script>

<div class="manage-library-backdrop" on:click={() => dispatch("close")}>
  <div class="manage-library-panel" on:click|stopPropagation>
    <header>
      <h2>Manage library</h2>
      <button class="close-btn" on:click={() => dispatch("close")}>✕</button>
    </header>

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
  </div>
</div>

<style>
  .manage-library-backdrop {
    position: fixed;
    inset: 0;
    z-index: 500;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .manage-library-panel {
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 8px;
    width: min(560px, 90vw);
    max-height: 80vh;
    overflow-y: auto;
    padding: 1rem 1.25rem;
    color: inherit;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  h3 {
    margin: 0.75rem 0 0.4rem;
    font-size: 0.95rem;
    color: #ccc;
  }
  .close-btn {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
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
</style>
