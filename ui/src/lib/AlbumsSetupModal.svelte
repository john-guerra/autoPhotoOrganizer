<script>
  import { createEventDispatcher } from "svelte";
  import Modal from "./Modal.svelte";
  import { renderAlbumName, parseDuration, fmtDur } from "./albums.js";

  export let open = false;
  export let prefs;
  export let sampleDate = new Date();
  export let dest = "";
  export let hasNativePicker = false;
  // The current folder's basename (App passes `currentFolderName`, derived
  // from focusPath / the current groupBy position / the first album photo's
  // folder — see App.svelte's `currentFolder`). Used only to preview/describe
  // the empty-template default "<folderName>_<n>". Source-specific, so it is
  // NOT part of the persisted `prefs`.
  export let currentFolderName = "";

  const dispatch = createEventDispatcher();

  // Local editable copy so Cancel discards. Re-seed when the modal (re)opens.
  let template = prefs.template;
  let gapMode = prefs.gapMode; // "fixed" | "auto"
  let fixedGapMs = prefs.fixedGapMs;
  let move = prefs.move;
  let localDest = dest;
  let gapInput = "";
  $: if (open) {
    // one-shot reseed guard
  }
  let lastOpen = false;
  $: if (open && !lastOpen) {
    template = prefs.template;
    gapMode = prefs.gapMode;
    fixedGapMs = prefs.fixedGapMs;
    move = prefs.move;
    localDest = dest;
    gapInput = fmtDur(fixedGapMs);
    lastOpen = true;
  }
  $: if (!open) lastOpen = false;

  $: preview = template.trim()
    ? renderAlbumName(template, sampleDate, 1)
    : `${currentFolderName || "Album"}_1`;

  const TOKENS = [
    ["%Y", "4-digit year", "2017"],
    ["%m", "month number", "01"],
    ["%b", "short month name", "Jan"],
    ["%B", "full month name", "January"],
    ["%d", "day of month", "09"],
    ["%H", "hour (24h)", "14"],
    ["%M", "minute", "30"],
    ["%n", "album number", "1, 2, 3…"],
    ["/", "make a subfolder", "subfolder"],
  ];
  function insertToken(tok) {
    template = template + tok;
  }

  function commitGap() {
    const ms = parseDuration(gapInput);
    if (ms != null) {
      fixedGapMs = ms;
      gapMode = "fixed";
    }
    gapInput = fmtDur(fixedGapMs);
  }
  function useAuto() {
    gapMode = "auto";
  }
  function useFixed() {
    gapMode = "fixed";
  }

  async function pickDest() {
    const p = await window.autogallery?.pickFolder();
    if (p) localDest = p;
  }

  function apply() {
    dispatch("apply", {
      template,
      gapMode,
      fixedGapMs,
      move,
      dest: localDest.trim(),
    });
    open = false;
  }
  function cancel() {
    open = false;
    dispatch("close");
  }
</script>

<Modal bind:open title="Auto Albums" size="lg" onclose={cancel}>
  <section class="how">
    <p>
      AutoGallery looks at <strong>when each photo and video was taken</strong>.
      When there's a long pause between shots, it starts a new album. Drag the
      split gap to make albums bigger or smaller — or let AutoGallery pick a gap
      automatically. Nothing is moved until you review and click Materialize.
    </p>
    <svg class="gap-diagram" viewBox="0 0 320 30" aria-hidden="true">
      <!-- cluster, big gap, cluster -->
      {#each [8, 16, 24, 34, 44] as x}<circle cx={x} cy="15" r="4" />{/each}
      {#each [150, 160, 172, 184] as x}<circle cx={x} cy="15" r="4" />{/each}
      {#each [286, 296, 306] as x}<circle cx={x} cy="15" r="4" />{/each}
      <text x="95" y="19" class="gap-label">↤ new album ↦</text>
    </svg>
  </section>

  <section class="field">
    <span class="lbl">Split gap</span>
    <div class="gap-row">
      <button class:active={gapMode === "fixed"} on:click={useFixed}
        >Fixed</button
      >
      <input
        class="gap-input"
        bind:value={gapInput}
        on:blur={commitGap}
        on:keydown={(e) => e.key === "Enter" && commitGap()}
        placeholder="e.g. 1m, 30m, 2h, 1d"
        disabled={gapMode !== "fixed"}
      />
      <button
        class:active={gapMode === "auto"}
        on:click={useAuto}
        title="mean + k·stddev of gaps">Auto</button
      >
    </div>
    <p class="hint">
      {gapMode === "auto"
        ? "Auto: AutoGallery picks the gap from this set's rhythm."
        : `Fixed gap: ${fmtDur(fixedGapMs)}.`}
    </p>
  </section>

  <section class="field">
    <span class="lbl">Folder naming</span>
    <input
      class="tpl"
      bind:value={template}
      spellcheck="false"
      placeholder={`e.g. %Y/%Y_%m%b_%d — leave empty for ${currentFolderName || "<folder>"}_1, ${currentFolderName || "<folder>"}_2`}
    />
    <p class="hint">e.g. <code>Album %n</code> → Album 1, Album 2</p>
    <div class="tokens">
      {#each TOKENS as [tok, desc, ex]}
        <button
          class="token"
          title={`${desc} — e.g. ${ex}`}
          on:click={() => insertToken(tok)}>{tok}</button
        >
      {/each}
    </div>
    <p class="preview">
      Preview: <code>{localDest || "<destination>"}/{preview}</code>
    </p>
  </section>

  <section class="field">
    <span class="lbl">Save by</span>
    <div class="move-row">
      <label><input type="radio" value={true} bind:group={move} /> Move</label>
      <label><input type="radio" value={false} bind:group={move} /> Copy</label>
    </div>
    <div class="dest-row">
      <input
        class="dest"
        bind:value={localDest}
        placeholder="/materialize/destination"
        spellcheck="false"
      />
      {#if hasNativePicker}<button on:click={pickDest}>Choose…</button>{/if}
    </div>
  </section>

  {#snippet footer()}
    <button on:click={cancel}>Cancel</button>
    <button class="primary" on:click={apply}>Preview albums</button>
  {/snippet}
</Modal>

<style>
  .how p {
    margin: 0 0 0.5rem;
    line-height: 1.5;
    color: #cfcfcf;
    font-size: 0.9rem;
  }
  .gap-diagram {
    width: 100%;
    height: 30px;
  }
  .gap-diagram circle {
    fill: #4c9aff;
  }
  .gap-diagram .gap-label {
    fill: #7a7a7a;
    font-size: 9px;
  }
  .field {
    margin-top: 1rem;
  }
  .lbl {
    display: block;
    font-size: 0.8rem;
    color: #9a9a9a;
    margin-bottom: 0.35rem;
  }
  .gap-row,
  .move-row,
  .dest-row,
  .tokens {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .gap-row button,
  .token,
  .dest-row button {
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    color: #e8e8e8;
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .gap-row button.active {
    background: #2e8b57;
    border-color: #2e8b57;
    color: #06121f;
  }
  .gap-input,
  .tpl,
  .dest {
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 6px;
    color: inherit;
    padding: 5px 8px;
    font: inherit;
    font-size: 0.85rem;
  }
  .tpl {
    width: 100%;
  }
  .dest {
    flex: 1;
  }
  .token {
    font-variant-numeric: tabular-nums;
  }
  .hint,
  .preview {
    font-size: 0.8rem;
    color: #9a9a9a;
    margin: 0.4rem 0 0;
  }
  .preview code {
    color: #7fe0a8;
    word-break: break-all;
  }
  .primary {
    background: #2e8b57;
    border: 1px solid #2e8b57;
    color: #06121f;
    font-weight: 600;
    border-radius: 6px;
    padding: 5px 12px;
    cursor: pointer;
  }
  button {
    background: #222;
    border: 1px solid #3a3a3a;
    color: #e8e8e8;
    border-radius: 6px;
    padding: 5px 12px;
    cursor: pointer;
  }
</style>
