/**
 * Pure keyboard-navigation helpers for the justified grid — no DOM, no
 * Svelte, following the same pattern as justified.js/windowing.js. Moved
 * out of App.svelte (see GitHub issue #42) as step 1 of a larger
 * modularization: these three functions were already pure (took their
 * dependencies as arguments, not closure reads), just living inline.
 */

/**
 * Placeholders (in-place folded rows for a collapsed section) are never a
 * valid keyboard-selection target, matching how section headers already
 * aren't part of the selectable index space. Steps from `from` in `dir`
 * (+1/-1) until landing on a non-placeholder entry, or returns null if
 * the entries run out in that direction first.
 * @param {Array<{kind?: string}>} entries
 * @param {number} from
 * @param {1|-1} dir
 * @returns {number|null}
 */
export function nextSelectable(entries, from, dir) {
  let i = from;
  while (i >= 0 && i < entries.length && entries[i]?.kind === "placeholder") {
    i += dir;
  }
  if (i < 0 || i >= entries.length) return null;
  return i;
}

/**
 * Nearest box in the row adjacent (in direction `dir`) to `fromIndex`'s
 * row, by horizontal centre — the geometric core of navVertical, factored
 * out so navVertical can re-run it from an intermediate (placeholder)
 * landing spot without needing `selected` itself. Returns null when
 * `fromIndex` is already on the first/last row.
 * @param {Array<{x:number,y:number,width:number,height:number}>} boxes
 * @param {number} fromIndex
 * @param {1|-1} dir
 * @returns {number|null}
 */
export function nearestBoxInAdjacentRow(boxes, fromIndex, dir) {
  const cur = boxes[fromIndex];
  if (!cur) return null;
  const curCx = cur.x + cur.width / 2;
  // Find the y coordinate of the adjacent row.
  let rowY = null;
  for (let i = 0; i < boxes.length; i++) {
    const t = boxes[i].y;
    if (dir > 0 ? t > cur.y : t < cur.y) {
      if (
        rowY === null ||
        (dir > 0 ? t < rowY : t > rowY) // nearest row in that direction
      )
        rowY = t;
    }
  }
  if (rowY === null) return null; // already on the first/last row
  // Nearest horizontal centre within that row.
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i].y !== rowY) continue;
    const d = Math.abs(boxes[i].x + boxes[i].width / 2 - curCx);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Vertical navigation in a justified layout: rows have varying column
 * counts, so move to the box in the adjacent row whose horizontal centre is
 * nearest to the current one. If that lands on a placeholder, keep
 * advancing row by row (placeholders are never a valid selection target)
 * until a real entry is found or there's no further row, in which case the
 * original selection is kept.
 * @param {Array<{x:number,y:number,width:number,height:number}>|null} boxes
 * @param {Array<{kind?: string}>} displayEntries
 * @param {number} selected
 * @param {1|-1} dir
 * @returns {number}
 */
export function navVertical(boxes, displayEntries, selected, dir) {
  if (!boxes) return selected;
  const start = selected;
  let cur = start;
  while (true) {
    const next = nearestBoxInAdjacentRow(boxes, cur, dir);
    if (next === null) return start; // no further row that direction
    if (displayEntries[next]?.kind !== "placeholder") return next;
    cur = next; // placeholder row — keep looking past it
  }
}
