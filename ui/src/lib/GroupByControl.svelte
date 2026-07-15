<script>
  /**
   * The grouping pills (the MultiAutoSelect widget).
   *
   * It lived among the filters, which read as a category error: grouping doesn't
   * narrow the library, it decides how what's left is CARVED UP — the same
   * question the tree/fisheye switch answers for the sidebar. So it sits next to
   * that switch now, and the filter row holds only things that take photos away.
   *
   * Presentational: renders the current groupBy and emits `groupbychange`.
   */
  import { ALL_DIMENSIONS } from "./dimensions.js";
  import MultiAutoSelect from "multi-auto-select";

  let { groupBy = ["folder"], ongroupbychange } = $props();

  /** Svelte action: mounts the real MultiAutoSelect DOM widget into the node,
   * seeds it with the current `groupBy`, and emits `groupbychange` when the
   * user reorders/adds/removes a pill. (Seeds once on mount — matches the
   * prior inline behavior; external groupBy changes don't re-sync the widget.) */
  function groupBySelector(node, initialValue) {
    const widget = MultiAutoSelect(ALL_DIMENSIONS, {
      value: initialValue,
      title: "Group by",
      placeholder: "Add…",
      sortable: true,
      layout: "compact",
    });
    widget.addEventListener("input", () => ongroupbychange?.(widget.value));
    node.appendChild(widget);
    return {
      destroy() {
        widget.remove();
      },
    };
  }
</script>

<div class="group-by" use:groupBySelector={groupBy}></div>

<style>
  /* NEVER shrinks. Starve this widget of width and MultiAutoSelect doesn't clip,
     it WRAPS its own pills onto a second and third line — which grows the toolbar
     row and reflows everything in it. That was the original reported bug. */
  .group-by {
    flex-shrink: 0;
  }
  .group-by :global(.multi-auto-select) {
    color: inherit;
  }
  /* Compact layout: keep the "Group by" title small and the whole widget
     vertically tight so it fits the toolbar row. */
  .group-by :global(.multi-auto-select.compact .title) {
    font-size: 0.7rem;
    color: #9a9a9a;
    margin-bottom: 1px;
  }
  .group-by :global(.multi-auto-select.compact) {
    min-height: 0 !important;
  }
  .group-by :global(.pill) {
    background: #2a2a2a !important;
    color: #eee !important;
    border-color: #444 !important;
  }
</style>
