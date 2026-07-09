/**
 * Pure keyboard-navigation helpers for the justified grid — no DOM, no
 * Svelte, following the same pattern as justified.js/windowing.js. Moved
 * out of App.svelte (see GitHub issue #42) as step 1 of a larger
 * modularization: these three functions were already pure (took their
 * dependencies as arguments, not closure reads), just living inline.
 */
import { resolvePhoto } from "./displayEntries.js";

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

/** Finds the displayEntries index whose entry represents photo `id` —
 * either directly (a plain photo entry, or a stack entry whose cover IS
 * id), or as a collapsed stack's non-cover member. resolvePhoto(entry)
 * only ever returns a stack's cover photo, so `resolvePhoto(e).id ===
 * id` alone can never match a member id that isn't the cover — a
 * server-resolved focusId/targetId lands on whichever raw photo the
 * seek found, with no awareness of this client-side burst grouping, so
 * it can legitimately be a hidden member. Landing on that member's
 * stack (showing its cover) is the correct behavior, not a fallback.
 * Moved out of App.svelte (issue #42).
 * @param {Array<object>} entries
 * @param {number|string} id
 * @returns {number}
 */
export function findEntryIndexForId(entries, id) {
  return entries.findIndex((e) =>
    e.kind === "stack"
      ? e.stack.memberIds.includes(id)
      : resolvePhoto(e).id === id
  );
}

/** Resolves the `selected` index for a feed re-center: lands on `targetId`
 * when it's present in `entries`, otherwise falls back to the first
 * non-placeholder entry in `fallbackDir` from the start (or 0 if every
 * entry is a placeholder). Shared by the canonical
 * recenterFeedOnId helper and any other re-center path (issue #42).
 * @param {Array<object>} entries
 * @param {number|string|null} targetId
 * @param {1|-1} [fallbackDir]
 * @returns {number}
 */
export function resolveSelectedIndex(entries, targetId, fallbackDir = 1) {
  if (targetId != null) {
    const idx = findEntryIndexForId(entries, targetId);
    if (idx !== -1) return idx;
  }
  return nextSelectable(entries, 0, fallbackDir) ?? 0;
}
