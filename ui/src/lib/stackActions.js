/**
 * Orchestration for the manual burst-stack actions (issue #24), kept OUT of
 * App.svelte so the component only delegates. Pure item transforms
 * (`applyCreateToItems` / `applyDissolveToItems`) are unit-testable in
 * isolation; the async wrappers add persistence; `buildStackMenuItems` produces
 * the context-menu item objects (labels + enablement live here, not in App).
 *
 * The live-update contract mirrors toggleCover: each action returns the NEXT
 * `items` array, and the caller reassigns `items = nextItems` to retrigger the
 * reactive `stacks` recompute — no feed reload, so no copy of the feed-window
 * guard (CLAUDE.md "no 7th copy" rule).
 */
import { createStack, dissolveStackApi } from "./api.js";
import { canCreateManualStack } from "./stackOverrides.js";

/** New items array with `ids` forced into manual stack `groupId` (clears the
 * keep-separate flag — mutual exclusion). Pure. */
export function applyCreateToItems(items, ids, groupId) {
  const set = ids instanceof Set ? ids : new Set(ids);
  return items.map((it) =>
    set.has(it.id) ? { ...it, manualStackId: groupId, keepSeparate: false } : it
  );
}

/** New items array with `ids` marked keep-separate and pulled out of any manual
 * stack. Pure. */
export function applyDissolveToItems(items, ids) {
  const set = ids instanceof Set ? ids : new Set(ids);
  return items.map((it) =>
    set.has(it.id) ? { ...it, keepSeparate: true, manualStackId: null } : it
  );
}

/** Persist a manual stack for the current selection, then return the updated
 * items. Await-first (server allocates the group_id) avoids optimistic-sentinel
 * reconciliation. @returns {Promise<{nextItems, groupId, count}>} */
export async function createManualStackFromSelection(items, selectedIds) {
  const ids = [...selectedIds];
  const { groupId, count } = await createStack(ids);
  return { nextItems: applyCreateToItems(items, ids, groupId), groupId, count };
}

/** Persist a dissolve for `memberIds`, then return the updated items.
 * @returns {Promise<{nextItems, count}>} */
export async function dissolveStackMembers(items, memberIds) {
  const { count } = await dissolveStackApi(memberIds);
  return { nextItems: applyDissolveToItems(items, memberIds), count };
}

/** The member ids of the stack a context-menu target entry belongs to, or null
 * if the target isn't part of a stack. `stacks` is the current stacks array. */
export function targetStackMemberIds(entry, stacks) {
  if (!entry) return null;
  if (entry.kind === "stack") return entry.stack.memberIds;
  if (entry.kind === "photo" && entry.stackId) {
    return stacks.find((s) => s.id === entry.stackId)?.memberIds ?? null;
  }
  return null;
}

/**
 * Build the manual-stack context-menu items. Returns an array of
 * {label, action, enabled} to spread into App's contextMenuItems.
 * @param {object} ctx
 * @param {Array} ctx.items                the feed window
 * @param {Set<number>} ctx.selectedIds
 * @param {string[]} ctx.groupBy
 * @param {Array} ctx.displayEntries
 * @param {number} ctx.targetIndex         index into displayEntries (the right-clicked tile)
 * @param {Array} ctx.stacks               current stacks
 * @param {(ids:number[]) => void} ctx.onCreate    called with the selection ids
 * @param {(memberIds:number[]) => void} ctx.onDissolve  called with the target stack's member ids
 */
export function buildStackMenuItems({
  items,
  selectedIds,
  groupBy,
  displayEntries,
  targetIndex,
  stacks,
  onCreate,
  onDissolve,
}) {
  const menu = [];

  const canCreate = canCreateManualStack(items, selectedIds, groupBy);
  menu.push({
    label: `Create stack from ${selectedIds.size} photo${selectedIds.size === 1 ? "" : "s"}`,
    enabled: canCreate,
    action: () => onCreate([...selectedIds]),
  });

  const targetEntry = displayEntries?.[targetIndex];
  const memberIds = targetStackMemberIds(targetEntry, stacks);
  menu.push({
    label: "Dissolve stack",
    enabled: Array.isArray(memberIds) && memberIds.length > 0,
    action: () => onDissolve(memberIds),
  });

  return menu;
}
