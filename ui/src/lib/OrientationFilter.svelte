<script>
  import { createEventDispatcher } from "svelte";
  import { ORIENTATIONS, toggleOrientation } from "./filterSpec.js";

  export let filter;
  const dispatch = createEventDispatcher();
  const LABELS = {
    landscape: "Landscape",
    portrait: "Portrait",
    square: "Square",
  };
  $: on = new Set(filter?.orientations ?? []);

  function toggle(o) {
    dispatch("change", toggleOrientation(filter, o));
  }
</script>

<div class="orient" role="group" aria-label="Filter by orientation">
  {#each ORIENTATIONS as o}
    <button
      type="button"
      class="shape {o}"
      class:on={on.has(o)}
      on:click={() => toggle(o)}
      title={LABELS[o]}
      aria-label={LABELS[o]}
      aria-pressed={on.has(o)}><span class="glyph"></span></button
    >
  {/each}
</div>

<style>
  .orient {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .shape {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    cursor: pointer;
    background: transparent;
    border: 1px solid #333;
    border-radius: 5px;
  }
  .shape .glyph {
    border: 1.5px solid #6a6a6a;
    border-radius: 1px;
  }
  .shape.landscape .glyph {
    width: 15px;
    height: 10px;
  }
  .shape.portrait .glyph {
    width: 10px;
    height: 15px;
  }
  .shape.square .glyph {
    width: 12px;
    height: 12px;
  }
  .shape.on {
    border-color: #4c9aff;
    background: rgba(76, 154, 255, 0.14);
  }
  .shape.on .glyph {
    border-color: #4c9aff;
  }
</style>
