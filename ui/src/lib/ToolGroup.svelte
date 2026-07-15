<script>
  /**
   * One labelled, bordered group of toolbar controls — which folds into a dropdown
   * when the row it lives in runs out of room.
   *
   * A toolbar of undifferentiated icons makes the user work out for themselves
   * which of them is the reason they can only see 300 of their 114,000 photos.
   * Every group here answers exactly one question — Library, Filter, Group, View —
   * and says so on the tin.
   *
   * A real <fieldset>/<legend>, because that is the one element that draws a
   * border, names the group, and announces it to a screen reader without a
   * wrapper. Its UA styling has to be undone first, which is most of the CSS.
   *
   * `flavor` carries the group's LAYOUT, not its looks: the toolbar's shrink order
   * lives here, in one place, rather than being re-derived in six components. The
   * rules use :global because the children arrive through a slot and belong to the
   * caller's style scope, not this one.
   *
   * FOLDING. ToolbarRow decides (see toolbarOverflow.js); this draws the result. A
   * folded group keeps its controls exactly where they are in the DOM — the
   * fieldset is taken out of flow and positioned as a popover next to its trigger.
   * Nothing is unmounted and nothing is re-parented, so no control loses its state
   * and the shrink rules below go on applying inside the panel.
   */
  import { getContext, tick } from "svelte";
  import {
    computePosition,
    autoUpdate,
    offset,
    flip,
    shift,
  } from "@floating-ui/dom";

  let {
    label,
    /** Lit border + legend: this group is currently DOING something (e.g. a filter
     * is hiding photos). The answer to "why can't I see them?" should be visible
     * from across the room — including when the group has folded away, which is
     * exactly when the control doing it is no longer on screen. */
    active = false,
    /** "" | "filters" | "view" — see the layout rules below. */
    flavor = "",
    /** Identifies this group to ToolbarRow's fold order. A group with no id, or one
     *  the row doesn't list, never folds. */
    id = "",
    legendAction,
    children,
  } = $props();

  const foldedStore = getContext("toolbarOverflow")?.folded;

  let folded = $derived(Boolean(id) && Boolean($foldedStore?.has(id)));

  let open = $state(false);
  let triggerEl = $state();
  let panelEl = $state();
  let stopAutoUpdate = null;

  /**
   * The popover is driven IMPERATIVELY — from the toggle, not from a reactive
   * statement — and that is not a style preference.
   *
   * `$: track(open && folded, triggerEl, panelEl)` looks like the natural way to
   * write this, and it locks the tab up the instant you click the trigger. A
   * reactive statement re-runs when a dependency is INVALIDATED, and Svelte's
   * safe_not_equal reports every object as changed even when it is the very same
   * object — so a statement that depends on a `bind:this` element re-fires on
   * every flush, forever, each run scheduling the next. The deps never change; the
   * dirty bit never clears.
   *
   * So: no DOM element ever appears in a `$:` here. Only `folded`, a boolean.
   */
  function toggle() {
    open ? close() : openPanel();
  }

  async function openPanel() {
    open = true;
    await tick(); // the panel is display:none until `open` lands — measure it after
    if (!triggerEl || !panelEl) return;
    // The trigger moves whenever the toolbar re-lays-out; autoUpdate re-runs the
    // placement on scroll, resize and layout shift, so the panel is never left
    // hanging next to where its button used to be.
    stopAutoUpdate = autoUpdate(triggerEl, panelEl, place);
  }

  function close() {
    open = false;
    stopAutoUpdate?.();
    stopAutoUpdate = null;
  }

  // The row unfolds as the window widens; a panel still open then would be a
  // floating duplicate of controls that are already back in the toolbar.
  $effect(() => {
    if (!folded && open) close();
  });

  $effect(() => () => stopAutoUpdate?.());

  async function place() {
    const { x, y } = await computePosition(triggerEl, panelEl, {
      placement: "bottom-start",
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    });
    panelEl.style.left = `${x}px`;
    panelEl.style.top = `${y}px`;
  }

  function onWindowClick(e) {
    if (!open) return;
    if (triggerEl?.contains(e.target) || panelEl?.contains(e.target)) return;
    close();
  }
</script>

<svelte:window
  onclick={onWindowClick}
  onkeydown={(e) => {
    if (e.key === "Escape" && open) close();
  }}
/>

<!-- display:contents — the fieldset (or, folded, the trigger) stays a DIRECT flex
     item of the row, so the flavor rules below still decide what grows and what
     shrinks. A real wrapper box here would swallow them. -->
<div class="tg">
  {#if folded}
    <button
      class="tg-trigger"
      class:active
      class:open
      bind:this={triggerEl}
      aria-expanded={open}
      aria-haspopup="true"
      title={`${label} — folded into a menu because the window is narrow`}
      onclick={toggle}
    >
      {label}
      <span class="chev" aria-hidden="true">▾</span>
    </button>
  {/if}

  <fieldset
    class="tool-group {flavor}"
    class:active
    class:folded
    class:open
    bind:this={panelEl}
  >
    <!-- The legend can carry an action of its own — e.g. Filter's "clear". It
         rides IN the legend rather than in the group's body so it sits on the
         border, reads as being about the whole group, and doesn't take a slot in
         the row of controls. -->
    <legend>
      {label}
      {@render legendAction?.()}
    </legend>
    {@render children?.()}
  </fieldset>
</div>

<style>
  .tg {
    display: contents;
  }

  .tool-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    /* Tight. The border is there to SAY where the group ends, not to frame it —
       a fieldset's default padding is generous enough to push the toolbar's rows
       apart and make six groups look like six panels. */
    padding: 0 6px 2px;
    border: 1px solid #2f2f2f;
    border-radius: 8px;
    min-width: 0;
    /* Nothing WRAPS. The toolbar used to be a wrapping flex row in which every
       child was unshrinkable, so "wrap" was its only relief valve: add a third
       grouping dimension and the pills dropped onto a second line, reflowing the
       whole bar. Groups hold their size unless a flavor below says otherwise —
       and when the row can give no more, ToolbarRow folds one away entirely. */
    flex-wrap: nowrap;
    flex-shrink: 0;
  }
  .tool-group.active {
    border-color: #3c5f8a;
  }
  legend {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 3px;
    margin-left: 2px;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #7c7c7c;
    white-space: nowrap;
  }
  .tool-group.active legend {
    color: #4c9aff;
  }

  /* The View group spans row 2's leftover width so that Sort, at its far right,
     lands hard against the toolbar's right edge. Its CONTENTS never shrink — the
     spacer inside it does the giving. */
  .tool-group.view {
    flex-grow: 1;
    flex-shrink: 0;
  }

  /* The filter group is the one that flexes, because it holds the two controls
     that can lose width without losing meaning. */
  .tool-group.filters {
    flex-grow: 1;
    flex-shrink: 1;
  }
  /* But NOTHING inside it shrinks by default. Flex items are flex-shrink:1 out of
     the box, so the moment the group itself became shrinkable every child started
     giving up width at once — the Type filter had its last button sliced off by
     its neighbour. Exactly two children are allowed to give. */
  .tool-group.filters > :global(*) {
    flex-shrink: 0;
  }
  /* The search box: the text scrolls, so you can still read the tail of what you
     typed. */
  .tool-group.filters > :global(.search) {
    flex-shrink: 1;
    min-width: 0;
  }
  /* The timeline takes — and gives back — all the slack. A shorter axis is still
     an axis, where an icon just gets clipped. It stops at 260px, which is roughly
     where its two end-date badges begin to collide. */
  .tool-group.filters > :global(.time-filter) {
    flex: 1 1 320px;
    min-width: 260px;
  }

  /* ---- Folded: the group is a dropdown ---- */

  .tg-trigger {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
    height: 30px;
    padding: 0 9px;
    border: 1px solid #2f2f2f;
    border-radius: 8px;
    background: #1a1a1a;
    color: #b8b8b8;
    font: inherit;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    white-space: nowrap;
    cursor: pointer;
  }
  .tg-trigger:hover,
  .tg-trigger.open {
    background: #262626;
    color: #e8e8e8;
  }
  /* A folded group that is still hiding photos has to go on saying so: this is the
     one state in which the control responsible is nowhere on screen. */
  .tg-trigger.active {
    border-color: #3c5f8a;
    color: #4c9aff;
  }
  .chev {
    font-size: 0.6rem;
    opacity: 0.7;
  }

  .tool-group.folded {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 60;
    /* A panel now, not a strip in a row: it may use more than one line, and it has
       to stay wide enough for the timeline to still be an axis. */
    flex-wrap: wrap;
    width: max-content;
    max-width: min(680px, calc(100vw - 16px));
    padding: 2px 10px 10px;
    background: #1a1a1a;
    border-color: #383838;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
    /* Undo the row flavors — inside a panel there is no row to grow into. */
    flex-grow: 0;
    flex-shrink: 0;
  }
  .tool-group.folded:not(.open) {
    display: none;
  }
  .tool-group.folded > :global(.time-filter) {
    flex: 1 1 100%;
    min-width: 300px;
  }
</style>
