/**
 * When the toolbar runs out of room, groups fold into dropdowns instead of
 * falling off the edge.
 *
 * The rows are `flex-wrap: nowrap` (a wrapping toolbar reflowed the whole bar
 * every time you added a grouping dimension — see Toolbar.svelte), and the shrink
 * order in ToolGroup only buys so much: once the search box and the timeline are
 * at their floor, the next pixel you take away pushes a control off the right edge
 * where it can neither be seen nor reached. A modern toolbar folds; it doesn't
 * amputate.
 *
 * WHY A STATE MACHINE AND NOT A WIDTH SUM. The obvious approach — measure each
 * group's natural width, add them up, compare to the row — cannot work here,
 * because two of these groups are deliberately elastic (the Filter group grows and
 * shrinks; the timeline inside it gives up 60px before it complains). Their
 * "natural width" is a range, not a number, and their real floor is decided by the
 * browser's flex solver, not by us. So we don't predict: we MEASURE the row's
 * actual overflow, fold one group, and look again.
 *
 * WHY THRESHOLDS. Folding a group frees width, which makes the row fit, which
 * would immediately make it a candidate to unfold — a loop, every frame, forever.
 * So a folded group remembers the width at which it did not fit and refuses to
 * unfold until the row is genuinely WIDER than that. The recorded width only ever
 * rises, so the machine converges instead of oscillating.
 */

/**
 * One step of the fold/unfold decision. Pure: the caller measures, applies the
 * result, and measures again on the next frame until `changed` is false.
 *
 * @param {object} s
 * @param {boolean} s.overflowing  does the row's content exceed its box RIGHT NOW?
 * @param {number} s.available     the row's current inner width, in px
 * @param {string[]} s.order       group ids, FIRST to fold ... LAST to fold. A
 *                                 group absent from this list never folds (the ＋
 *                                 menu: fold the one door into the library and the
 *                                 user cannot add a photo).
 * @param {string[]} s.folded      currently folded ids
 * @param {Record<string, number>} s.thresholds  id → the width at which it last
 *                                 failed to fit
 * @returns {{folded: string[], thresholds: Record<string, number>, changed: boolean}}
 */
export function stepOverflow({
  overflowing,
  available,
  order,
  folded,
  thresholds,
}) {
  const isFolded = new Set(folded);

  if (overflowing) {
    // Fold the next one in line. One per step, so we never fold a group that a
    // single earlier fold would have made room for.
    const next = order.find((id) => !isFolded.has(id));
    if (!next) return { folded, thresholds, changed: false }; // nothing left to give
    return {
      folded: [...folded, next],
      // It did not fit at THIS width, so it may not come back at this width.
      thresholds: {
        ...thresholds,
        [next]: Math.max(available, thresholds[next] ?? 0),
      },
      changed: true,
    };
  }

  // Room to spare — give a group back, in the reverse of the order we took them,
  // so the one folded most reluctantly is the first to return. Only if the row is
  // now strictly wider than it was when this group last failed to fit.
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (!isFolded.has(id)) continue;
    if (available > (thresholds[id] ?? 0)) {
      return {
        folded: folded.filter((f) => f !== id),
        thresholds,
        changed: true,
      };
    }
    // The most-reluctantly-folded group cannot come back yet, so neither can the
    // ones folded before it: they only folded because this one wasn't enough.
    break;
  }

  return { folded, thresholds, changed: false };
}
