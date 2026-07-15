<script>
  // Media-kind filter (image / raw / video), mirroring OrientationFilter.
  // Descriptive icons with a "Type" legend; all-on (or all-off) = no filter, a
  // strict subset narrows the view.
  import { KINDS, toggleKind } from "./filterSpec.js";

  let { filter, onchange } = $props();
  const LABELS = {
    image: "Photos",
    raw: "RAW",
    video: "Videos",
  };
  let on = $derived(new Set(filter?.kinds ?? []));

  function toggle(k) {
    onchange?.(toggleKind(filter, k));
  }
</script>

<div class="kinds" role="group" aria-label="Filter by media type">
  <span class="legend">Type</span>
  {#each KINDS as k}
    <button
      type="button"
      class="kind"
      class:on={on.has(k)}
      onclick={() => toggle(k)}
      title={`Show ${LABELS[k]}`}
      aria-label={`Show ${LABELS[k]}`}
      aria-pressed={on.has(k)}
    >
      {#if k === "image"}
        <!-- photo: framed picture with a sun + hill -->
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect
            x="2"
            y="3"
            width="12"
            height="10"
            rx="1.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
          />
          <circle cx="5.5" cy="6.5" r="1.1" fill="currentColor" />
          <path
            d="M3 12l3-3 2 2 2.5-3L13 12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
        </svg>
      {:else if k === "video"}
        <!-- video: frame with a play triangle -->
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect
            x="2"
            y="3.5"
            width="12"
            height="9"
            rx="1.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
          />
          <path d="M6.5 6l4 2-4 2z" fill="currentColor" />
        </svg>
      {:else}
        <!-- raw: no universal glyph — the word IS the descriptive marker -->
        <span class="raw-glyph">RAW</span>
      {/if}
    </button>
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
    padding: 2px 4px 2px 2px;
  }
  .legend {
    font-size: 0.7rem;
    color: #8a8a8a;
    padding: 0 4px 0 4px;
    white-space: nowrap;
  }
  .kind {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 4px;
    padding: 3px 6px;
    min-height: 22px;
    cursor: pointer;
    background: transparent;
    color: #9a9a9a;
  }
  .kind svg {
    width: 16px;
    height: 16px;
    display: block;
  }
  .raw-glyph {
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    line-height: 1;
  }
  .kind.on {
    background: #4c9aff;
    color: #06121f;
  }
</style>
