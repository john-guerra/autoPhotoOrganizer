<script>
  /**
   * Machine learning, as its own panel (#205).
   *
   * These controls used to live at the bottom of the Manage library dialog,
   * below the thumbnail cache and the metadata section — a place nobody
   * looking for "which model am I running" would scroll to. They have grown
   * into a settings domain of their own (model, execution provider, CPU share,
   * counts, near-duplicate threshold and window, purge, retry), so they get a
   * panel of their own.
   *
   * Deliberately a thin shell: every control, every fetch and every piece of
   * copy still lives in MlSettings.svelte, which is also still embedded in
   * Manage library. Duplicating the panel's contents to give it a second home
   * would mean two places to keep the consent text honest, and the consent
   * text is the part that must never drift.
   */
  import Modal from "./Modal.svelte";
  import MlSettings from "./MlSettings.svelte";
  import SemanticSearch from "./SemanticSearch.svelte";
  import FaceSettings from "./FaceSettings.svelte";

  /** Passed straight through to MlSettings AND FaceSettings so each scope
   *  selector can offer "Selected" and "Visible" (#215, #221) — the panel
   *  itself owns no grid state. Faces was missing this, which is why its only
   *  offer was the whole library. */
  let {
    onclose,
    selectedIds = [],
    /** Everything the scope control needs, straight from App — which owns the
     *  filter and the working set. The panel is a pass-through on purpose: it
     *  owns no grid state, and a panel that derived its own scope counts is
     *  how the two came to disagree (#245). */
    selectedInFilter = undefined,
    filterSpec = {},
    filteredCount = 0,
    keepActive = false,
    keepCount = 0,
    onrefinechange,
    onsemanticapply,
    onnotice,
  } = $props();

  // One object, so adding a scope input later cannot reach one panel and miss
  // the other — which is exactly how faces shipped with no scope at all.
  const scopeProps = $derived({
    selectedIds,
    selectedInFilter,
    filterSpec,
    filteredCount,
    keepActive,
    keepCount,
  });
</script>

<Modal
  open={true}
  title="Machine learning"
  size="md"
  onclose={() => onclose?.()}
>
  <div class="ml-panel">
    <!-- Search sits ABOVE the settings deliberately: it is the thing the model
         is FOR, and the model/threads/threshold controls below are the
         machinery that makes it possible. The UX review (#213) found the
         feature reading as "a button that computes something" precisely
         because the payoff was never on screen. -->
    <SemanticSearch
      onapply={(ids) => {
        onsemanticapply?.(ids);
        onclose?.();
      }}
    />

    <!-- Faces (#166) sit between the search and the machinery for the same
         reason search sits above both: they are a thing the models are FOR.
         The download button here is the only place in the app that asks the
         user to accept someone else's licence, so it must not be buried. -->
    <FaceSettings {...scopeProps} onnotice={(m) => onnotice?.(m)} />
    <hr />
    <MlSettings {...scopeProps} {onrefinechange} />
  </div>
</Modal>

<style>
  hr {
    border: none;
    border-top: 1px solid #333;
    margin: 1rem 0;
  }
  .ml-panel {
    /* The section renders its own <h3>, which would otherwise sit oddly close
       under the modal's title bar. */
    padding-top: 0.25rem;
  }
</style>
