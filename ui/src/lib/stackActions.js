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
import { detectBursts } from "./bursts.js";

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

/**
 * The selected photo ids that currently belong to some stack — the members a
 * selection-scoped dissolve (Shift+G over a selection) should mark keep-separate.
 *
 * Deliberately returns ONLY ids that are stacked right now: a `keepSeparate`
 * flag is persistent (it permanently stops a photo from auto-bursting), so
 * flagging every selected photo — including loose ones — would let a habit of
 * sweeping large ranges slowly disable auto-detection across the library. A
 * loose selected photo is left untouched so it can still burst on a later scan.
 * The result may span several stacks; the caller dissolves them in one call.
 *
 * @param {Set<number>|Iterable<number>} selectedIds
 * @param {Array<{memberIds: Array<number|string>}>} stacks  current stacks
 * @returns {Array<number|string>} de-duplicated stacked member ids from the selection
 */
export function selectedStackedMemberIds(selectedIds, stacks) {
  const sel = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const out = new Set();
  for (const stack of stacks ?? [])
    for (const id of stack.memberIds) if (sel.has(id)) out.add(id);
  return [...out];
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

/**
 * Stack a SELECTION by its own time gaps (#207).
 *
 * Manual stacking forces every selected photo into ONE stack no matter how the
 * shots are spread out inside it — which is right when the user is asserting
 * "these belong together", and wrong when they have swept up a run of photos
 * and want the ordinary burst rule applied to just that run. This is the
 * second thing: it clusters the selection exactly the way the grid's automatic
 * detection would, then persists each cluster as a manual stack so the result
 * survives a rescan and a change to the burst slider.
 *
 * Clusters of one are skipped rather than stacked alone: a one-photo stack is
 * not a stack, and persisting a manual group for it would freeze that photo
 * out of later automatic bursting for no benefit.
 *
 * Reuses `detectBursts` rather than re-deriving the rule. A second
 * implementation of "what counts as a burst" would drift from the one the grid
 * renders, and the user would get stacks that do not match what they were
 * looking at when they pressed the button.
 *
 * @param {Array<object>} items the feed window
 * @param {Set<number>|Iterable<number>} selectedIds
 * @param {number} gapMs the toolbar's current burst gap
 * @returns {Promise<{nextItems: Array<object>, stacks: number, photos: number}>}
 */
export async function burstSelectionIntoStacks(items, selectedIds, gapMs) {
  const set = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const selected = items.filter((it) => set.has(it.id));
  // gapMs 0 means the user has burst detection turned off; clustering with it
  // would put every photo in its own cluster and create nothing, so the caller
  // gets an honest zero rather than a silent no-op it cannot explain.
  const clusters = detectBursts(selected, { gapMs }).filter(
    (c) => c.memberIds.length >= 2
  );

  let nextItems = items;
  let photos = 0;
  for (const cluster of clusters) {
    // Sequential, not Promise.all: each call allocates a group_id server-side,
    // and the failure story matters more than the latency here — if one call
    // fails, the stacks already created stay created and the returned items
    // describe exactly those, rather than a half-applied batch nobody can
    // reconcile.
    const { groupId } = await createStack(cluster.memberIds);
    nextItems = applyCreateToItems(nextItems, cluster.memberIds, groupId);
    photos += cluster.memberIds.length;
  }
  return { nextItems, stacks: clusters.length, photos };
}
