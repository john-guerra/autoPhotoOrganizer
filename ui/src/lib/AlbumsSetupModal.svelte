<script>
  import { untrack } from "svelte";
  import Modal from "./Modal.svelte";
  import { renderAlbumName, parseDuration, fmtDur } from "./albums.js";

  let {
    open = $bindable(false),
    prefs,
    sampleDate = new Date(),
    dest = "",
    hasNativePicker = false,
    // The current folder's basename (App passes `currentFolderName`, derived
    // from focusPath / the current groupBy position / the first album photo's
    // folder — see App.svelte's `currentFolder`). Used only to preview/describe
    // the empty-template default "<folderName>_<n>". Source-specific, so it is
    // NOT part of the persisted `prefs`.
    currentFolderName = "",
    onapply,
    onclose,
  } = $props();

  // Local editable copy so Cancel discards. Re-seed when the modal (re)opens
  // (the $effect below); the initializers here only need to cover first
  // mount, so the reads are untracked — this is a one-shot seed, not a live
  // mirror of `prefs`/`dest`.
  let template = $state(untrack(() => prefs.template));
  let gapMode = $state(untrack(() => prefs.gapMode)); // "fixed" | "auto"
  let fixedGapMs = $state(untrack(() => prefs.fixedGapMs));
  let move = $state(untrack(() => prefs.move));
  let localDest = $state(untrack(() => dest));
  let gapInput = $state("");

  // Re-seed the local editable copy on the CLOSED→OPEN transition only (not on
  // every prefs/dest change while the modal stays open, or an in-progress edit
  // would get stomped). `lastOpen` is a plain (untracked) local, not $state —
  // reading it inside the effect would make the effect depend on its own write
  // and re-fire forever (see UpdateBanner's dismissal-reset pattern, §6 of
  // docs/svelte-5-migration.md).
  let lastOpen = false;
  $effect(() => {
    if (open && !lastOpen) {
      template = prefs.template;
      gapMode = prefs.gapMode;
      fixedGapMs = prefs.fixedGapMs;
      move = prefs.move;
      localDest = dest;
      gapInput = fmtDur(fixedGapMs);
    }
    lastOpen = open;
  });

  const preview = $derived(
    template.trim()
      ? renderAlbumName(template, sampleDate, 1, currentFolderName)
      : `${currentFolderName || "Album"}_1`
  );

  const TOKENS = [
    ["%Y", "4-digit year", "2017"],
    ["%m", "month number", "01"],
    ["%b", "short month name", "Jan"],
    ["%B", "full month name", "January"],
    ["%d", "day of month", "09"],
    ["%H", "hour (24h)", "14"],
    ["%M", "minute", "30"],
    ["%n", "album number", "1, 2, 3…"],
    ["%f", "this folder's name", currentFolderName || "Trip"],
    ["/", "make a subfolder", "subfolder"],
  ];
  // Ready-made naming schemes the user can pick from the combobox — or ignore
  // and type their own (it's a plain <input> backed by a <datalist>).
  const PRESETS = [
    ["%Y_%m%b_%d_%f_%n", "Date + folder + number — 2018_06Jun_30_Chicaque_1"],
    ["%Y_%m%b_%d_%f", "Date + folder — 2018_06Jun_30_Chicaque"],
    ["%Y/%Y_%m%b_%d_%f_%n", "Year ▸ date + folder + number"],
    ["%Y-%m-%d_%f", "ISO date + folder"],
    ["%Y-%m-%d", "ISO date only"],
    ["%f_%n", "Folder + number"],
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
    onapply?.({
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
    onclose?.();
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
      {#each [8, 16, 24, 34, 44] as x}<circle cx={x} cy="15" r="4"
        ></circle>{/each}
      {#each [150, 160, 172, 184] as x}<circle cx={x} cy="15" r="4"
        ></circle>{/each}
      {#each [286, 296, 306] as x}<circle cx={x} cy="15" r="4"></circle>{/each}
      <text x="95" y="19" class="gap-label">↤ new album ↦</text>
    </svg>
  </section>

  <section class="field">
    <span class="lbl">Split gap</span>
    <div class="gap-row">
      <button class:active={gapMode === "fixed"} onclick={useFixed}
        >Fixed</button
      >
      <input
        class="gap-input"
        bind:value={gapInput}
        onblur={commitGap}
        onkeydown={(e) => e.key === "Enter" && commitGap()}
        placeholder="e.g. 1m, 30m, 2h, 1d"
        disabled={gapMode !== "fixed"}
      />
      <button
        class:active={gapMode === "auto"}
        onclick={useAuto}
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
    <!-- A real <select> (not a <datalist>): a datalist is autocomplete — the
         browser hides every option that doesn't match the field's current text,
         so once a preset is filled in, opening it showed nothing. The select lists
         every preset outright; the text field beside it still takes a custom one.
         Both bind the same `template`, so picking a preset fills the field and
         typing a custom value flips the select to "Custom template". -->
    <div class="tpl-row">
      <select
        class="tpl-preset"
        bind:value={template}
        aria-label="Folder-naming preset"
      >
        {#each PRESETS as [value, label]}
          <option {value}>{label}</option>
        {/each}
        {#if !PRESETS.some(([v]) => v === template)}
          <option value={template}>Custom template</option>
        {/if}
      </select>
      <input
        class="tpl"
        bind:value={template}
        spellcheck="false"
        placeholder={`e.g. %Y_%m%b_%d_%f — leave empty for ${currentFolderName || "<folder>"}_1, ${currentFolderName || "<folder>"}_2`}
      />
    </div>
    <p class="hint">
      Pick a preset from the list or type your own. <code>%f</code> is this
      folder's name; <code>%n</code> the album number.
    </p>
    <div class="tokens">
      {#each TOKENS as [tok, desc, ex]}
        <button
          class="token"
          title={`${desc} — e.g. ${ex}`}
          onclick={() => insertToken(tok)}>{tok}</button
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
      {#if hasNativePicker}<button onclick={pickDest}>Choose…</button>{/if}
    </div>
  </section>

  {#snippet footer()}
    <button onclick={cancel}>Cancel</button>
    <button class="primary" onclick={apply}>Preview albums</button>
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
  .tpl-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .tpl-row .tpl {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
  }
  .tpl-preset {
    flex: 0 0 auto;
    max-width: 46%;
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 6px;
    color: inherit;
    padding: 5px 8px;
    font: inherit;
    font-size: 0.85rem;
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
