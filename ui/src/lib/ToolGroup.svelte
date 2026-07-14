<script>
  /**
   * One labelled, bordered group of toolbar controls.
   *
   * A toolbar of undifferentiated icons makes the user work out for themselves
   * which of them is the reason they can only see 300 of their 114,000 photos.
   * Every group here answers exactly one question — Library, Filter, Group, View,
   * Size, Sort — and says so on the tin.
   *
   * A real <fieldset>/<legend>, because that is the one element that draws a
   * border, names the group, and announces it to a screen reader without a
   * wrapper. Its UA styling has to be undone first, which is most of the CSS.
   *
   * `flavor` carries the group's LAYOUT, not its looks: the toolbar's shrink order
   * lives here, in one place, rather than being re-derived in six components. The
   * rules use :global because the children arrive through a slot and belong to the
   * caller's style scope, not this one.
   */
  export let label;
  /** Lit border + legend: this group is currently DOING something (e.g. a filter
   * is hiding photos). The answer to "why can't I see them?" should be visible
   * from across the room. */
  export let active = false;
  /** "" | "filters" | "view" — see the layout rules below. */
  export let flavor = "";
</script>

<fieldset class="tool-group {flavor}" class:active>
  <legend>{label}</legend>
  <slot />
</fieldset>

<style>
  .tool-group {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0;
    padding: 2px 10px 4px;
    border: 1px solid #2f2f2f;
    border-radius: 8px;
    min-width: 0;
    /* Nothing WRAPS. The toolbar used to be a wrapping flex row in which every
       child was unshrinkable, so "wrap" was its only relief valve: add a third
       grouping dimension and the pills dropped onto a second line, reflowing the
       whole bar. Groups hold their size unless a flavor below says otherwise. */
    flex-wrap: nowrap;
    flex-shrink: 0;
  }
  .tool-group.active {
    border-color: #3c5f8a;
  }
  legend {
    padding: 0 4px;
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
</style>
