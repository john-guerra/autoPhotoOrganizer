<script>
  /**
   * One row of the toolbar, and the thing that decides what to do when it runs
   * out of width: fold groups into dropdowns, in an order it is told, rather than
   * letting a control slide off the right edge.
   *
   * It measures; ToolGroup draws. The decision itself is a pure function — see
   * toolbarOverflow.js for why it is a measure-fold-remeasure loop and not a sum
   * of widths (two of these groups are elastic, so their width is a range).
   */
  import { setContext, onMount, tick } from "svelte";
  import { writable } from "svelte/store";
  import { stepOverflow } from "./toolbarOverflow.js";

  /** Group ids, FIRST to fold … LAST to fold. A group whose id isn't here never
   *  folds — the ＋ menu is the only door into the library, and a door you have to
   *  open a dropdown to find is a door you can't find. */
  export let order = [];
  /** Bump/change to re-measure when the CONTENT changed rather than the box: a
   *  third grouping pill makes the row overflow without changing its size, so no
   *  ResizeObserver fires. */
  export let watch = null;
  /** "primary" | "secondary" — names the row for tests and for anyone reading the
   *  DOM. It carries no styling of its own. */
  export let variant = "";

  const folded = writable(new Set());
  setContext("toolbarOverflow", { folded });

  let rowEl;
  let state = { folded: [], thresholds: {} };
  let settling = false;
  let queued = 0;

  /**
   * Never re-lay-out from INSIDE the ResizeObserver callback.
   *
   * Folding a group resizes the row, which is the very thing the observer is
   * watching — do it in the callback and the browser reports "ResizeObserver loop
   * completed with undelivered notifications", an uncaught error that (rightly)
   * fails `trackPageErrors`. Deferring to the next frame puts the work outside the
   * observation cycle, where a layout change is just a layout change.
   */
  function schedule() {
    if (queued) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      settle();
    });
  }

  async function settle() {
    if (!rowEl || settling) return;
    settling = true;
    // Bounded: each pass either folds one group, unfolds one, or stops. It cannot
    // do more of either than there are groups.
    for (let i = 0; i <= order.length; i++) {
      const next = stepOverflow({
        ...state,
        order,
        available: rowEl.clientWidth,
        // +1: sub-pixel layout rounding reports a 1px overflow on a row that fits.
        overflowing: rowEl.scrollWidth > rowEl.clientWidth + 1,
      });
      if (!next.changed) break;
      state = { folded: next.folded, thresholds: next.thresholds };
      folded.set(new Set(next.folded));
      await tick(); // let the row re-lay-out before we measure it again
    }
    settling = false;
  }

  $: (watch, order, schedule());

  onMount(() => {
    const ro = new ResizeObserver(schedule);
    ro.observe(rowEl);
    return () => {
      ro.disconnect();
      if (queued) cancelAnimationFrame(queued);
    };
  });
</script>

<div class="topbar-row {variant}" bind:this={rowEl}>
  <slot />
</div>

<style>
  /* ONE line, on purpose. The toolbar used to be a single wrapping flex row, so
     its only relief valve when it ran out of width was to wrap — add a third
     grouping dimension and the pills dropped onto a second line and shoved
     everything else around. Now it shrinks (the order lives in ToolGroup: the
     Filter group gives, and inside it the search box and the timeline give), and
     when there is nothing left to give, it folds. */
  .topbar-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: nowrap;
    min-width: 0;
  }
</style>
