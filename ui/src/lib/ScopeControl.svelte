<script>
  /**
   * WHAT SET OF PHOTOS DOES THIS OPERATION ACT ON? — contract 1 of
   * `docs/UI-CONTRACTS.md`, as one component.
   *
   * Extracted from `MlSettings.svelte` (#215/#206) so faces (#221) reuses it
   * rather than growing a second copy. The contract says so explicitly: "one
   * control, not one per feature. Three near-identical scope controls in three
   * places is already Finding 4 of ML-UX-REVIEW-2026-07-26.md. Extract and
   * reuse; do not copy."
   *
   * Presentational. The arithmetic is in `scopeControl.js` so it is testable
   * without a DOM, and so a caller can ask "which ids did they pick?" without
   * reaching inside this component.
   *
   * Two behaviours are load-bearing rather than cosmetic:
   *  - An empty scope is **offered but disabled**, never hidden. Hiding it
   *    makes the set of choices shift under the cursor as a selection changes.
   *  - The estimate **tracks the choice**. An estimate that does not move with
   *    the scope is worse than none, because the user plans around it.
   */
  import {
    buildScopes,
    activeScope,
    formatEstimate,
    DEFAULT_SCOPE,
  } from "./scopeControl.js";

  let {
    /** The fieldset's legend — the VERB, e.g. "Embed" or "Find faces in". */
    legend,
    /**
     * Radio-group name. MUST be unique per instance on the page: two groups
     * sharing a name are one group to the browser, so choosing a scope in the
     * faces panel would silently clear the embedding panel's.
     */
    name,
    testid = "ml-scope",
    selectedIds = [],
    visibleIds = [],
    /** What "All" means to THIS operation — its remaining work, not the
     *  library total. See buildScopes. */
    allCount = 0,
    allLabel = "All",
    /** Measured per-photo cost; omit and no estimate is shown. */
    msPerPhoto = undefined,
    /** Rendered after the count when an estimate is available, e.g. the model
     *  name. Kept out of this component so it does not need to know about
     *  models. */
    estimateSuffix = "",
    /** What is skipped inside any scope, so "up to" is explained. */
    emptyMessage = "Nothing to do in this scope.",
    disabled = false,
    choice = $bindable(DEFAULT_SCOPE),
  } = $props();

  const scopes = $derived(
    buildScopes({ selectedIds, visibleIds, allCount, allLabel })
  );
  const active = $derived(activeScope(scopes, choice));
  const estimate = $derived(formatEstimate(active?.n ?? 0, msPerPhoto));
</script>

<fieldset class="scope" data-testid={testid}>
  <legend>{legend}</legend>
  {#each scopes as s (s.key)}
    <label class="scope-opt" class:empty={!s.n}>
      <input
        type="radio"
        {name}
        value={s.key}
        checked={choice === s.key}
        disabled={disabled || !s.n}
        onchange={() => (choice = s.key)}
      />
      <span>{s.label}</span>
      <span class="scope-n">{s.n.toLocaleString()}</span>
    </label>
  {/each}
</fieldset>
<p class="hint" data-testid="{testid}-estimate">
  {#if !active?.n}
    {emptyMessage}
  {:else}
    Up to {active.n.toLocaleString()} photos{#if estimate}
      · <strong>{estimate}</strong>{/if}{estimateSuffix}
  {/if}
</p>

<style>
  .scope {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0.35rem 0.6rem;
    margin: 0.7rem 0 0;
  }
  .scope legend {
    padding: 0 0.3rem;
    font-size: 0.78rem;
    color: #ccc;
  }
  .scope-opt {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .scope-opt.empty {
    opacity: 0.45;
    cursor: default;
  }
  .scope-n {
    color: #888;
    font-variant-numeric: tabular-nums;
  }
  .hint {
    color: #888;
    font-size: 0.8rem;
    line-height: 1.4;
    margin: 0.35rem 0 0;
  }
</style>
