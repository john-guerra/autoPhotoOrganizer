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

  /** Passed straight through to MlSettings so its scope selector can offer
   *  "Selected" and "Visible" (#215) — the panel itself owns no grid state. */
  let { onclose, selectedIds = [], visibleIds = [] } = $props();
</script>

<Modal
  open={true}
  title="Machine learning"
  size="md"
  onclose={() => onclose?.()}
>
  <div class="ml-panel">
    <MlSettings {selectedIds} {visibleIds} />
  </div>
</Modal>

<style>
  .ml-panel {
    /* The section renders its own <h3>, which would otherwise sit oddly close
       under the modal's title bar. */
    padding-top: 0.25rem;
  }
</style>
