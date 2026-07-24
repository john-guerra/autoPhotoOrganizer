/**
 * Pure set-algebra for the photo selection (issue #124, extraction 1).
 *
 * `App.svelte` holds the selection as a `Set<number>` of stable DB row ids and,
 * being Svelte 4, reassigns the whole set to trigger reactivity
 * (`selectedIds = selectedIds`). Every mutation therefore has to produce a set
 * value rather than mutate in place, and that clone-to-reassign ritual was
 * hand-inlined at ~8 call sites. Centralising it here removes that logic from
 * the 5,000-line component, makes it unit-testable in isolation, and gives the
 * later Svelte-5 runes conversion a single place to simplify (a `$state` Set no
 * longer needs the reassign).
 *
 * These functions never mutate their `Set` argument — they return a new one —
 * so a caller can safely do `selectedIds = withIds(selectedIds, ids)`. Ids that
 * are not integers are ignored (a photo with no numeric id is never selectable),
 * matching the guards the inline code already had.
 */

/** Parse the persisted selection (a JSON array of ids) back into an id list,
 * tolerating a missing/corrupt value by returning `[]`. Only integer ids
 * survive — the store is written from a `Set<number>`, but a hand-edited or
 * partially-written localStorage value must not poison the selection. */
export function parseStoredSelection(raw) {
  try {
    const stored = JSON.parse(raw ?? "null");
    if (Array.isArray(stored)) return stored.filter((n) => Number.isInteger(n));
  } catch {
    /* fall through to empty */
  }
  return [];
}

/** Toggle one id's membership, returning a new set. A non-integer id is a
 * no-op (returns an equivalent new set), mirroring `toggleSelect`'s guard. */
export function toggleId(set, id) {
  const next = new Set(set);
  if (!Number.isInteger(id)) return next;
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Union `ids` into the selection (never removes), returning a new set. This is
 * the accumulate-don't-fight rule shared by selectMatching / selectAllInView /
 * group + bulk select: lowering a star threshold or adding manual picks only
 * ever grows the selection. */
export function withIds(set, ids) {
  const next = new Set(set);
  for (const id of ids) if (Number.isInteger(id)) next.add(id);
  return next;
}

/** Remove `ids` from the selection, returning a new set. */
export function withoutIds(set, ids) {
  const next = new Set(set);
  for (const id of ids) next.delete(id);
  return next;
}

/** The numeric ids of the photos between two indices (inclusive) in an ordered
 * list — the shift-click range. `photos[k]` is whatever the grid resolved at
 * that slot (a collapsed stack contributes its cover photo only); entries with
 * no numeric id are skipped. Order-independent in `a`/`b`. */
export function rangeIds(photos, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const ids = [];
  for (let k = lo; k <= hi; k++) {
    const p = photos[k];
    if (p && Number.isInteger(p.id)) ids.push(p.id);
  }
  return ids;
}

/** A shift-click range longer than this asks before selecting. A range is a
 * mouse gesture that's easy to overshoot across a big grid, so the floor is far
 * lower than the whole-group threshold (BIG_GROUP_SELECT, 1000) — 51+ photos in
 * one shift-click is worth a "did you mean that?" (issue #141). */
export const RANGE_SELECT_CONFIRM = 50;

/** Should a shift-click range of `count` photos be confirmed before selecting?
 * Only ever asked of a SELECT — a range never deselects, and the escape hatch
 * (clear / undo) must never itself ask a question. */
export function needsRangeConfirm(count) {
  return count > RANGE_SELECT_CONFIRM;
}
