/**
 * Applies the persisted manual burst-stack overrides (issue #24) on top of the
 * automatic detection from bursts.js. Pure — no DOM, no Svelte. This is the
 * single seam: App.svelte does
 *   $: stacks = applyStackOverrides(detectBurstsByGroup(items, groupBy, opts), items)
 * and every downstream consumer (buildDisplayEntries, layout, Thumb props,
 * toggleCover/toggleExpand) sees the overridden stacks with no other change.
 *
 * Each item carries two override fields threaded through the feed (see
 * server/db/feed.js rowToItem):
 *   - `manualStackId: number|null` — photos sharing a value are forced together.
 *   - `keepSeparate: boolean` — the dissolve flag; the photo never auto-stacks.
 * A photo is in exactly one of three states (enforced server-side): auto,
 * manually grouped, or kept-separate.
 *
 * Manual stacks are built from `manualStackId` INDEPENDENTLY of the time-gap
 * detector, so they still render when burst detection is turned off entirely
 * (gapMs 0 → no auto stacks). See
 * docs/superpowers/specs/2026-07-11-manual-burst-override-design.md.
 */
import { pickCoverId } from "./pickCover.js";

/**
 * @param {Array<{id, memberIds, coverId, count}>} autoStacks  output of detectBursts
 * @param {Array<{id, name, rating?, preferredCover?, manualStackId?, keepSeparate?}>} items  the feed window
 * @returns {Array<{id, memberIds, coverId, count}>}  final stacks (same shape)
 */
export function applyStackOverrides(autoStacks, items) {
  const byId = new Map(items.map((it) => [it.id, it]));

  // Bucket present items by manual group. Preserve window order for memberIds.
  const groups = new Map();
  for (const it of items) {
    if (it.manualStackId == null) continue;
    if (!groups.has(it.manualStackId)) groups.set(it.manualStackId, []);
    groups.get(it.manualStackId).push(it);
  }

  const manualStacks = [];
  const overriddenIds = new Set();
  for (const [groupId, members] of groups) {
    // A stack needs ≥2 visible tiles; a group with one present member (the rest
    // outside the loaded window) renders as a normal photo — the persisted
    // override is untouched and regroups once more of the window loads.
    if (members.length < 2) continue;
    for (const m of members) overriddenIds.add(m.id);
    manualStacks.push({
      id: `manual-${groupId}`,
      memberIds: members.map((m) => m.id),
      coverId: pickCoverId(members),
      count: members.length,
    });
  }
  // Kept-separate photos never belong to any stack.
  for (const it of items) if (it.keepSeparate) overriddenIds.add(it.id);

  // Split overridden members out of the auto stacks; drop a stack that falls
  // below 2 survivors (its lone member becomes a normal photo automatically).
  const survivingAuto = [];
  for (const stack of autoStacks) {
    const survivors = stack.memberIds.filter((id) => !overriddenIds.has(id));
    if (survivors.length === stack.memberIds.length) {
      survivingAuto.push(stack);
      continue;
    }
    if (survivors.length < 2) continue;
    const members = survivors.map((id) => byId.get(id)).filter(Boolean);
    survivingAuto.push({
      id: stack.id, // keep the stable derived id (anchored to first member)
      memberIds: survivors,
      coverId: pickCoverId(members),
      count: survivors.length,
    });
  }

  // Order is irrelevant — buildDisplayEntries positions each stack at its
  // first-occurring member in `items` order, and membership is disjoint (a
  // manual member was removed from any overlapping auto stack above).
  return [...survivingAuto, ...manualStacks];
}

/**
 * Whether the current selection can become one manual stack: ≥2 photos, all
 * present in the loaded window, all in the same group (identical groupValues
 * across every active groupBy dimension — manual stacks are single-group only).
 * @param {Array<{id, groupValues?}>} items
 * @param {Set<number>|Iterable<number>} selectedIds
 * @param {string[]} groupBy
 * @returns {boolean}
 */
export function canCreateManualStack(items, selectedIds, groupBy) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  if (ids.size < 2) return false;
  const byId = new Map(items.map((it) => [it.id, it]));
  const sel = [...ids].map((id) => byId.get(id));
  if (sel.some((x) => !x)) return false; // some selected photo isn't in the window
  const first = sel[0].groupValues ?? {};
  return sel.every((x) =>
    (groupBy ?? []).every((d) => (x.groupValues ?? {})[d] === first[d])
  );
}
