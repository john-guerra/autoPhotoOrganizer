<script>
  // Keyboard shortcuts reference (issue #26). Presentational modal: a static,
  // context-grouped list of every shortcut, kept in sync by hand with
  // App.svelte's onKeydown. Built on the shared Modal (native <dialog>), which
  // owns Esc-to-close/backdrop/focus trap; the `?` key to open is owned by
  // App.svelte's onKeydown (single keyboard owner) to avoid a
  // capture-vs-bubble double-toggle.
  import Modal from "./Modal.svelte";

  let { onclose } = $props();
  const close = () => onclose?.();

  // The platform's own modifier key (lib/platform.js). Listing both as
  // "⌘ / Ctrl" rendered the slash as its own <kbd> pill — it read as a third key
  // to press. Nobody needs the shortcut for the OS they aren't using.
  import { MOD } from "./platform.js";

  // Each group: a heading + rows of {keys, label}. `keys` is an array so each
  // token renders as its own <kbd>; connective tokens ("+", "arrow", "–")
  // render as plain text between keys.
  const groups = [
    {
      heading: "Grid & Loupe",
      rows: [
        { keys: ["1", "–", "5"], label: "Set star rating" },
        { keys: ["0"], label: "Clear rating" },
        { keys: ["X"], label: "Toggle selection (auto-advances in loupe)" },
        {
          keys: [MOD, "+", "A"],
          label: "Select this group — again for everything shown",
        },
        {
          keys: [MOD, "+", "Shift", "+", "A"],
          label: "Deselect this group — again for everything shown",
        },
        { keys: ["C"], label: "Set / unset this photo as its stack's cover" },
        { keys: ["G"], label: "Group the selected photos into one stack" },
        {
          keys: ["Shift", "+", "G"],
          label:
            "Dissolve bursts in the selection (or the stack at the cursor)",
        },
        { keys: ["Right-click"], label: "Reveal / stack actions menu" },
      ],
    },
    {
      heading: "Grid",
      rows: [
        { keys: ["+"], label: "Zoom in (larger thumbnails)" },
        { keys: ["−"], label: "Zoom out (smaller thumbnails)" },
        { keys: ["←", "→", "↑", "↓"], label: "Move selection" },
        {
          keys: ["Shift", "+", "arrow"],
          label: "Extend selection while moving",
        },
        { keys: ["Home"], label: "Jump to the first photo" },
        { keys: ["End"], label: "Jump to the last photo" },
        { keys: ["["], label: "Scrubber: jump to the previous landmark" },
        { keys: ["]"], label: "Scrubber: jump to the next landmark" },
        { keys: ["Enter"], label: "Open in loupe (or expand a stack)" },
        { keys: ["Space"], label: "Open in loupe (or expand a stack)" },
        { keys: ["Esc"], label: "Collapse the current stack" },
        {
          keys: ["Alt", "+", "←", "→"],
          label:
            "Jump to prev / next group (at the edges, to the first / last photo)",
        },
      ],
    },
    {
      heading: "Loupe",
      rows: [
        { keys: ["←", "→", "↑", "↓"], label: "Previous / next photo" },
        { keys: ["Shift", "+", "arrow"], label: "Extend selection" },
        { keys: ["I"], label: "Toggle the details panel" },
        { keys: ["F"], label: "Toggle the filmstrip" },
        { keys: ["Esc"], label: "Close the loupe" },
      ],
    },
    {
      heading: "General",
      rows: [
        { keys: [","], label: "Open scrolling & prefetch settings" },
        { keys: ["?"], label: "Toggle this shortcuts list" },
      ],
    },
    {
      heading: "Search & filter",
      rows: [
        { keys: ["/"], label: "Jump to the search box (name or folder)" },
        { keys: ["Enter"], label: "Search now, without waiting" },
        { keys: ["Esc"], label: "Clear the search" },
      ],
    },
    {
      heading: "Library tree",
      rows: [
        {
          keys: ["Shift", "+", "click"],
          label:
            "On a folder's ▸ triangle: fold every sub-folder under it. On its grid/strip/bar icon: cycle every group beneath it at once",
        },
        {
          keys: ["hover"],
          label:
            "Slide a clipped folder name back into view (its full path is in the tooltip)",
        },
      ],
    },
  ];
</script>

<Modal open={true} title="Keyboard shortcuts" size="lg" onclose={close}>
  <div class="groups">
    {#each groups as group}
      <section>
        <h3>{group.heading}</h3>
        <dl>
          {#each group.rows as row}
            <div class="row">
              <dt>
                {#each row.keys as k}
                  {#if k === "+" || k === "arrow" || k === "–"}
                    <span class="join">{k === "arrow" ? "arrow" : k}</span>
                  {:else}
                    <kbd>{k}</kbd>
                  {/if}
                {/each}
              </dt>
              <dd>{row.label}</dd>
            </div>
          {/each}
        </dl>
      </section>
    {/each}
  </div>
  {#snippet footer()}
    <span>Press <kbd>?</kbd> anytime to toggle this list.</span>
  {/snippet}
</Modal>

<style>
  .groups {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem 1.75rem;
  }
  section {
    break-inside: avoid;
  }
  section h3 {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #8ab4ff;
    margin: 0.75rem 0 0.35rem;
  }
  dl {
    margin: 0;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 3px 0;
  }
  dt {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 3px;
    min-width: 118px;
  }
  dd {
    margin: 0;
    color: #cfcfcf;
    font-size: 0.85rem;
  }
  kbd {
    display: inline-block;
    min-width: 1.1em;
    text-align: center;
    padding: 2px 6px;
    background: #2c2c2c;
    border: 1px solid #444;
    border-bottom-width: 2px;
    border-radius: 5px;
    font:
      600 0.78rem/1 ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    color: #f0f0f0;
  }
  .join {
    color: #777;
    font-size: 0.8rem;
    padding: 0 1px;
  }
</style>
