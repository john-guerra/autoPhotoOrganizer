<script>
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { thumbUrl } from "./api.js";
  import {
    fetchMissing,
    relocateMissing,
    dismissMissing,
    carryMissing,
  } from "./api.js";
  import { toggleId } from "./selectionOps.js";

  let { onclose, onchanged } = $props();

  let items = $state([]);
  let loading = $state(true);
  let error = $state("");
  let selected = $state(new Set());
  let dismissArmed = $state(false); // two-click confirm for bulk dismiss
  let relocatingId = $state(null); // row showing its destination input
  let destPath = $state("");
  let busy = $state(false);

  const hasNativePicker =
    typeof window !== "undefined" && !!window.autogallery?.pickFolder;

  async function load() {
    loading = true;
    error = "";
    try {
      const { items: rows } = await fetchMissing();
      items = rows;
      selected = new Set(); // ids may have changed under us
      dismissArmed = false;
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }
  onMount(load);

  function coverageLabel(c) {
    if (c.kind === "covered") {
      const where = c.survivors
        .map((s) => s.absPath)
        .slice(0, 2)
        .join(", ");
      return `still on disk — ${where}`;
    }
    if (c.kind === "ambiguous") return "moved? needs a choice";
    return "no other copy";
  }

  async function doDismiss() {
    if (!selected.size) return;
    if (!dismissArmed) {
      dismissArmed = true;
      return;
    }
    busy = true;
    error = "";
    try {
      // For a still-covered row, carry its metadata onto a surviving copy first
      // (server no-ops if the survivor already has its own).
      for (const row of items) {
        if (!selected.has(row.id)) continue;
        if (
          row.classification.kind === "covered" &&
          row.classification.survivors[0]
        ) {
          await carryMissing(row.id, row.classification.survivors[0].id);
        }
      }
      await dismissMissing([...selected]);
      onchanged?.();
      await load();
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
      dismissArmed = false;
    }
  }

  function startRelocate(row) {
    relocatingId = row.id;
    destPath = "";
    error = "";
  }

  async function pickDest() {
    try {
      const p = await window.autogallery?.pickFolder?.(destPath.trim());
      if (p) destPath = p;
    } catch (e) {
      error = e.message;
    }
  }

  async function confirmRelocate(row) {
    const folder = destPath.trim();
    if (!folder) return;
    busy = true;
    error = "";
    try {
      // A move keeps the filename; destAbsPath is folder + the original name.
      const dest = folder.replace(/\/+$/, "") + "/" + row.filename;
      await relocateMissing(row.id, dest);
      relocatingId = null;
      onchanged?.();
      await load();
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
</script>

<Modal open={true} title="Missing files" size="lg" onclose={() => onclose?.()}>
  {#if loading}
    <p class="mr-empty">Checking what’s missing…</p>
  {:else if error}
    <p class="mr-error" role="alert">{error}</p>
  {:else if items.length === 0}
    <p class="mr-empty">
      Nothing’s missing — every indexed photo is where the app expects it.
    </p>
  {:else}
    <div class="mr-actions">
      <span class="mr-count">{selected.size} selected</span>
      <button
        class="mr-dismiss"
        disabled={!selected.size || busy}
        onclick={doDismiss}
      >
        {dismissArmed
          ? `Dismiss ${selected.size} — click to confirm`
          : "Dismiss"}
      </button>
    </div>
    <ul class="mr-list">
      {#each items as row (row.id)}
        <li class="mr-row" class:sel={selected.has(row.id)}>
          <input
            type="checkbox"
            checked={selected.has(row.id)}
            onchange={() => (selected = toggleId(selected, row.id))}
            aria-label={`Select ${row.filename}`}
          />
          <img
            class="mr-thumb"
            src={thumbUrl(row.id, 96)}
            alt={row.filename}
            loading="lazy"
          />
          <div class="mr-info">
            <div class="mr-name" title={row.absPath + "/" + row.filename}>
              {row.filename}
            </div>
            <div class="mr-path">{row.absPath}</div>
            <div class="mr-tags">
              <span class="mr-coverage mr-{row.classification.kind}">
                {coverageLabel(row.classification)}
              </span>
              {#if row.rating > 0}<span class="mr-stars"
                  >{"★".repeat(row.rating)}</span
                >{/if}
            </div>
          </div>
          <div class="mr-rowactions">
            {#if relocatingId === row.id}
              {#if hasNativePicker}
                <button onclick={pickDest} disabled={busy}>Choose…</button>
              {/if}
              <input
                class="mr-dest"
                placeholder="/new/folder"
                bind:value={destPath}
                spellcheck="false"
              />
              <button
                disabled={!destPath.trim() || busy}
                onclick={() => confirmRelocate(row)}
              >
                Relocate
              </button>
              <button onclick={() => (relocatingId = null)} disabled={busy}
                >Cancel</button
              >
            {:else}
              <button onclick={() => startRelocate(row)} disabled={busy}
                >Relocate…</button
              >
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</Modal>

<style>
  .mr-empty,
  .mr-error {
    padding: 1.5rem 0.5rem;
    text-align: center;
    color: #aaa;
  }
  .mr-error {
    color: #ff6b6b;
  }
  .mr-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0 0 0.5rem;
    border-bottom: 1px solid #333;
  }
  .mr-count {
    color: #aaa;
    font-size: 0.85rem;
  }
  .mr-dismiss {
    margin-left: auto;
  }
  .mr-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 60vh;
    overflow-y: auto;
  }
  .mr-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.25rem;
    border-bottom: 1px solid #262626;
  }
  .mr-row.sel {
    background: #22303d;
  }
  .mr-thumb {
    width: 48px;
    height: 48px;
    object-fit: cover;
    border-radius: 3px;
    background: #111;
    flex: 0 0 auto;
  }
  .mr-info {
    min-width: 0;
    flex: 1 1 auto;
  }
  .mr-name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mr-path {
    color: #888;
    font-size: 0.78rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mr-tags {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.15rem;
  }
  .mr-coverage {
    font-size: 0.72rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: #333;
    color: #cfe;
  }
  .mr-covered {
    background: #244; /* still safe elsewhere */
    color: #9fe;
  }
  .mr-gone {
    background: #422;
    color: #f9b;
  }
  .mr-stars {
    color: #ffd24c;
    font-size: 0.75rem;
  }
  .mr-rowactions {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    flex: 0 0 auto;
  }
  .mr-dest {
    width: 12rem;
  }
</style>
