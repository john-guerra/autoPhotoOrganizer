/**
 * Merges raw items with detected bursts (from ui/src/lib/bursts.js) into
 * the grid's display list: a burst collapses to one entry (shown as its
 * cover) unless the stack's id is in `expandedStackIds`, in which case
 * every member appears as its own entry, tagged with the stack it
 * belongs to.
 *
 * A stack's entry/entries appear at the position of its first-occurring
 * member in `items` order — unrelated photos are never reordered.
 *
 * Pure — no DOM, no Svelte. See
 * docs/superpowers/specs/2026-07-06-burst-stacks-grid-integration-design.md.
 *
 * @param {Array<{id: number|string}>} items
 * @param {Array<{id: string, memberIds: Array<number|string>, coverId: number|string, count: number}>} stacks
 * @param {Set<string>} expandedStackIds
 * @returns {Array<
 *   | { kind: 'photo', item: object, stackId: string|null }
 *   | { kind: 'stack', stack: object, coverItem: object, peekItems: object[] }
 *   | { kind: 'placeholder', item: object }
 * >}
 */
export function buildDisplayEntries(items, stacks, expandedStackIds) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const stackByMemberId = new Map();
  for (const stack of stacks) {
    for (const id of stack.memberIds) stackByMemberId.set(id, stack);
  }

  const emittedStackIds = new Set();
  const entries = [];
  for (const item of items) {
    if (item.collapsed) {
      entries.push({ kind: "placeholder", item });
      continue;
    }
    const stack = stackByMemberId.get(item.id);
    if (!stack) {
      entries.push({ kind: "photo", item, stackId: null });
    } else if (expandedStackIds.has(stack.id)) {
      entries.push({ kind: "photo", item, stackId: stack.id });
    } else if (!emittedStackIds.has(stack.id)) {
      emittedStackIds.add(stack.id);
      const peekItems = stack.memberIds
        .filter((id) => id !== stack.coverId)
        .map((id) => byId.get(id))
        .filter(Boolean);
      entries.push({
        kind: "stack",
        stack,
        coverItem: byId.get(stack.coverId),
        peekItems,
      });
    }
    // else: a later member of an already-emitted collapsed stack — skip.
  }
  return entries;
}

/** Stable DOM/data-id for a display entry. */
export function entryDomId(entry) {
  if (entry.kind === "placeholder") return String(entry.item.id);
  return String(entry.kind === "stack" ? entry.stack.id : entry.item.id);
}

/** The underlying photo a display entry represents (a stack's cover, the
 * photo itself, or — for a placeholder entry — the placeholder object
 * itself, which callers must check `entry.kind` before treating as a real
 * photo). */
export function resolvePhoto(entry) {
  return entry.kind === "stack" ? entry.coverItem : entry.item;
}
