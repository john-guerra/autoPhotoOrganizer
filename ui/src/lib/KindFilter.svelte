<script>
  // Media-kind filter chips (image / raw / video), mirroring OrientationFilter.
  // All-on (or all-off) = no filter; a strict subset narrows the view.
  import { createEventDispatcher } from "svelte";
  import { KINDS, toggleKind } from "./filterSpec.js";

  export let filter;
  const dispatch = createEventDispatcher();
  const LABELS = {
    image: "Photos",
    raw: "RAW",
    video: "Videos",
  };
  $: on = new Set(filter?.kinds ?? []);

  function toggle(k) {
    dispatch("change", toggleKind(filter, k));
  }
</script>

<div class="kinds" role="group" aria-label="Filter by media type">
  {#each KINDS as k}
    <button
      type="button"
      class="kind"
      class:on={on.has(k)}
      on:click={() => toggle(k)}
      title={`Show ${LABELS[k]}`}
      aria-label={`Show ${LABELS[k]}`}
      aria-pressed={on.has(k)}>{LABELS[k]}</button
    >
  {/each}
</div>

<style>
  .kinds {
    display: inline-flex;
    gap: 2px;
    align-items: center;
    background: #101010;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 2px;
  }
  .kind {
    border: none;
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 0.75rem;
    cursor: pointer;
    background: transparent;
    color: #9a9a9a;
    white-space: nowrap;
  }
  .kind.on {
    background: #4c9aff;
    color: #06121f;
    font-weight: 600;
  }
</style>
