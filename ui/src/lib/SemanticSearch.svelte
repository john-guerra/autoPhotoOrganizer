<script>
  /**
   * Search photos by what is IN them (#164).
   *
   * ## Why this is a ranked list with a cut, and not a set of tags
   *
   * The obvious design is a vocabulary scored once into tags. It cannot be
   * made correct with this model: SigLIP's cosine is uncalibrated (its sigmoid
   * scale and bias are absent from the split ONNX exports), so the score
   * distribution SHIFTS per phrase — 0.06 is the top 1% for "dog" and the top
   * 3% for "sunset". No constant means "this is a dog", and a percentile is no
   * better, since "top 1%" would assert the library holds exactly 168 dog
   * photos whether it holds five hundred or none. The measurements are in
   * server/ml/textSearch.js.
   *
   * So nothing is thresholded. The library is ranked, the user drags the cut
   * to where the results stop being dogs, and THAT judgement — the one thing
   * the model cannot produce — is what gets saved.
   *
   * Searching is free (~10 ms over vectors #161 already computed), so the
   * results update as you type without any of this being precious.
   */
  import { searchByPhrase, saveSemanticTag, thumbUrl } from "./api.js";

  let { onapply } = $props();

  let q = $state("");
  let busy = $state(false);
  let error = $state("");
  let result = $state(null);
  /** How many of the ranked results the user is keeping. */
  let cut = $state(40);
  let saving = $state(false);
  let saved = $state("");

  /** The generation guard. Searches are cheap and fire per keystroke, so a
   *  slow one CAN land after a faster later one and overwrite it with results
   *  for a phrase the user has already moved on from. Same shape as the feed's
   *  epoch guard, and for the same reason. */
  let generation = 0;

  async function run() {
    const phrase = q.trim();
    saved = "";
    if (!phrase) {
      result = null;
      error = "";
      return;
    }
    const mine = ++generation;
    busy = true;
    error = "";
    try {
      const r = await searchByPhrase(phrase, 300);
      if (mine !== generation) return; // a later search already answered
      result = r;
      cut = Math.min(40, r.results.length);
    } catch (e) {
      if (mine !== generation) return;
      result = null;
      error = e.message;
    } finally {
      if (mine === generation) busy = false;
    }
  }

  /** Debounced so a fast typist fires one search per pause, not per letter.
   *  A plain number, never a DOM node — see CLAUDE.md on reactive statements. */
  let timer = null;
  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(run, 220);
  }

  let kept = $derived(result ? result.results.slice(0, cut) : []);
  /** Where the kept set sits in the library's own distribution. The raw score
   *  is meaningless on its own (see above); against the distribution it is the
   *  only honest way to say "this is the top 2%". */
  let cutPercent = $derived(
    result && result.scored ? (100 * cut) / result.scored : 0
  );

  async function save() {
    if (!result || !kept.length) return;
    saving = true;
    error = "";
    try {
      const r = await saveSemanticTag(
        result.query,
        kept.map((k) => k.photoId)
      );
      saved = `Saved “${result.query}” — ${r.photos.toLocaleString()} photo${r.photos === 1 ? "" : "s"}${
        r.keptManual ? `, keeping ${r.keptManual} you added by hand` : ""
      }`;
    } catch (e) {
      error = `Couldn't save the tag: ${e.message}`;
    } finally {
      saving = false;
    }
  }
</script>

<section class="sem" data-testid="semantic-search">
  <h3>Search by what is in the photo</h3>
  <p class="lede">
    Type anything — “sunset”, “whiteboard”, “my dog on a sofa”. There is no
    fixed list of words. Nothing is downloaded per search: this compares your
    phrase against photos already read by the model.
  </p>

  <label class="row">
    <span class="sr-only">Search phrase</span>
    <input
      type="text"
      placeholder="a photo of a sunset"
      bind:value={q}
      oninput={onInput}
      onkeydown={(e) => e.key === "Enter" && run()}
      data-testid="semantic-input"
    />
    <button onclick={run} disabled={busy || !q.trim()}>
      {busy ? "Searching…" : "Search"}
    </button>
  </label>

  {#if error}
    <p class="err" data-testid="semantic-error">{error}</p>
  {/if}

  {#if result}
    <div class="summary" data-testid="semantic-summary">
      Ranked <strong>{result.scored.toLocaleString()}</strong> photos. Keeping
      the top
      <strong>{cut.toLocaleString()}</strong>
      ({cutPercent < 1 ? cutPercent.toFixed(1) : Math.round(cutPercent)}% of the
      library).
    </div>

    <!-- The cut. Deliberately the only "threshold" in the feature, and it is
         the user's, expressed in photos rather than in a similarity score
         they have no way to interpret. -->
    <label class="cut">
      <span>How many to keep</span>
      <input
        type="range"
        min="1"
        max={result.results.length}
        step="1"
        bind:value={cut}
        data-testid="semantic-cut"
      />
      <span class="cut-n">{cut}</span>
    </label>

    <div class="strip" data-testid="semantic-results">
      {#each kept.slice(0, 60) as r (r.photoId)}
        <img
          src={thumbUrl(r.photoId, 128)}
          alt=""
          loading="lazy"
          title={`score ${r.score.toFixed(4)}`}
        />
      {/each}
    </div>
    {#if kept.length > 60}
      <p class="more">
        …and {(kept.length - 60).toLocaleString()} more in the kept set.
      </p>
    {/if}

    <div class="actions">
      <button
        onclick={() => onapply?.(kept.map((k) => k.photoId))}
        disabled={!kept.length}
        data-testid="semantic-show"
      >
        Show these in the grid
      </button>
      <button
        class="primary"
        onclick={save}
        disabled={saving || !kept.length}
        data-testid="semantic-save"
      >
        {saving ? "Saving…" : `Save as tag “${result.query}”`}
      </button>
    </div>
    {#if saved}
      <p class="ok" data-testid="semantic-saved">{saved}</p>
    {/if}
  {/if}
</section>

<style>
  .sem {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  h3 {
    margin: 0;
    font-size: 0.95rem;
  }
  .lede {
    margin: 0;
    font-size: 0.78rem;
    opacity: 0.75;
    line-height: 1.4;
  }
  .row {
    display: flex;
    gap: 0.5rem;
  }
  .row input {
    flex: 1;
    min-width: 0;
    background: #1c1c1c;
    color: inherit;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    padding: 0.35rem 0.5rem;
  }
  button {
    background: #2c2c2c;
    color: inherit;
    border: none;
    border-radius: 4px;
    padding: 0.35rem 0.7rem;
    cursor: pointer;
    white-space: nowrap;
  }
  button.primary {
    background: #2563eb;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .summary,
  .more {
    font-size: 0.78rem;
    opacity: 0.85;
    margin: 0;
  }
  .cut {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.78rem;
  }
  .cut input[type="range"] {
    flex: 1;
  }
  .cut-n {
    min-width: 2.5rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .strip {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    max-height: 15rem;
    overflow-y: auto;
  }
  .strip img {
    width: 64px;
    height: 64px;
    object-fit: cover;
    border-radius: 3px;
    background: #222;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .err {
    color: #f87171;
    font-size: 0.8rem;
    margin: 0;
  }
  .ok {
    color: #4ade80;
    font-size: 0.8rem;
    margin: 0;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
