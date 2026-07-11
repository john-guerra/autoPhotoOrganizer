<script>
  // Keyboard shortcuts reference (issue #26). Presentational modal: a static,
  // context-grouped list of every shortcut, kept in sync by hand with
  // App.svelte's onKeydown. Dismiss on backdrop click or the ✕; the `?`/Esc
  // keys are owned by App.svelte's onKeydown (single keyboard owner) to avoid a
  // capture-vs-bubble double-toggle.
  import { createEventDispatcher } from "svelte";

  const dispatch = createEventDispatcher();
  const close = () => dispatch("close");

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
        { keys: ["C"], label: "Set / unset this photo as its stack's cover" },
        { keys: ["G"], label: "Group the selected photos into one stack" },
        {
          keys: ["Shift", "+", "G"],
          label: "Dissolve the stack at the cursor",
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
        { keys: ["Enter"], label: "Open in loupe (or expand a stack)" },
        { keys: ["Space"], label: "Open in loupe (or expand a stack)" },
        { keys: ["Esc"], label: "Collapse the current stack" },
        { keys: ["Alt", "+", "←", "→"], label: "Jump to prev / next section" },
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
  ];
</script>

<div class="shortcuts-backdrop" on:click={close}>
  <div
    class="shortcuts-panel"
    role="dialog"
    aria-modal="true"
    aria-label="Keyboard shortcuts"
    on:click|stopPropagation
  >
    <header>
      <h2>Keyboard shortcuts</h2>
      <button class="close-btn" title="Close (Esc)" on:click={close}>✕</button>
    </header>

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

    <footer>
      <span>Press <kbd>?</kbd> anytime to toggle this list.</span>
    </footer>
  </div>
</div>

<style>
  .shortcuts-backdrop {
    position: fixed;
    inset: 0;
    z-index: 600;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .shortcuts-panel {
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 8px;
    width: min(720px, 92vw);
    max-height: 85vh;
    overflow-y: auto;
    padding: 1rem 1.25rem 1.25rem;
    color: #e8e8e8;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  header h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .close-btn {
    background: none;
    border: none;
    color: #999;
    font-size: 1rem;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
  }
  .close-btn:hover {
    background: #2c2c2c;
    color: #fff;
  }
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
  footer {
    margin-top: 1rem;
    padding-top: 0.6rem;
    border-top: 1px solid #2c2c2c;
    color: #888;
    font-size: 0.8rem;
  }
  footer kbd {
    font-size: 0.72rem;
  }
</style>
