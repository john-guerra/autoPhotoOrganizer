<script>
  /**
   * The one icon for a group's FEED state, shared by the tree sidebar and the
   * feed's section headers / snapshot heads / collapsed pills so the same thing
   * always looks the same.
   *
   * Deliberately NOT a triangle — a triangle means "fold sub-folders in the
   * tree". This says "how much of this group's photos the feed shows":
   *   expanded  → full grid   (2×2 squares)
   *   snapshot  → one strip   (a single row of frames)
   *   collapsed → nothing     (a single bar / pill)
   *   mixed     → some of each (half-filled grid)
   *
   * "mixed" only happens on a folder row that stands for several groups at once
   * (a virtual ancestor in the tree): its descendants disagree about how they're
   * rendered, and saying so is better than picking one of them and lying.
   */
  /**
   * A GroupRenderer's `icon` field — see lib/groupRenderers.js — or "mixed".
   * @type {{ state?: "grid" | "strip" | "bar" | "mixed" }}
   */
  let { state = "grid" } = $props();
</script>

{#if state === "mixed"}
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <rect x="1" y="1" width="4.4" height="4.4" rx="0.6" fill="currentColor" />
    <rect
      x="6.6"
      y="1"
      width="4.4"
      height="4.4"
      rx="0.6"
      fill="none"
      stroke="currentColor"
      stroke-width="1"
      opacity="0.65"
    />
    <rect
      x="1"
      y="6.6"
      width="4.4"
      height="4.4"
      rx="0.6"
      fill="none"
      stroke="currentColor"
      stroke-width="1"
      opacity="0.65"
    />
    <rect
      x="6.6"
      y="6.6"
      width="4.4"
      height="4.4"
      rx="0.6"
      fill="currentColor"
    />
  </svg>
{:else if state === "bar"}
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <rect x="1" y="5" width="10" height="2.4" rx="0.6" fill="currentColor" />
  </svg>
{:else if state === "strip"}
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <rect x="1" y="4" width="2.9" height="4" rx="0.6" fill="currentColor" />
    <rect x="4.55" y="4" width="2.9" height="4" rx="0.6" fill="currentColor" />
    <rect x="8.1" y="4" width="2.9" height="4" rx="0.6" fill="currentColor" />
  </svg>
{:else}
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <rect x="1" y="1" width="4.4" height="4.4" rx="0.6" fill="currentColor" />
    <rect x="6.6" y="1" width="4.4" height="4.4" rx="0.6" fill="currentColor" />
    <rect x="1" y="6.6" width="4.4" height="4.4" rx="0.6" fill="currentColor" />
    <rect
      x="6.6"
      y="6.6"
      width="4.4"
      height="4.4"
      rx="0.6"
      fill="currentColor"
    />
  </svg>
{/if}

<style>
  svg {
    width: 12px;
    height: 12px;
    display: block;
  }
</style>
