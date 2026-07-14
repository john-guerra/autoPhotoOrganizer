/**
 * Pure helpers for a group/album label's tri-state selection indicator
 * (issue #88). The client holds a flat set of selected photo ids; a group's
 * membership is fetched and cached separately (see App.svelte's groupIdCache).
 * These functions turn "how many of this group's ids are selected" into the
 * `none | some | all` state the label icon renders.
 */

/**
 * @param {number} selectedInGroup how many of the group's photos are selected
 * @param {number} groupSize total photos in the group (filter-consistent)
 * @returns {"none"|"some"|"all"}
 */
export function selectState(selectedInGroup, groupSize) {
  if (groupSize <= 0 || selectedInGroup <= 0) return "none";
  // `>=` (not `===`) so a stale over-count can never read as a partial "some".
  if (selectedInGroup >= groupSize) return "all";
  return "some";
}

/**
 * Above this many photos, selecting a group asks before it acts.
 *
 * Clicking a folder takes everything in the folders under it too, so one click on
 * a folder near the root of a real library can be worth tens of thousands of
 * photos — and it sits right next to the folder's name, where you click to look
 * at it. The number is a judgement, not a measurement: high enough that selecting
 * a card, a shoot or a day never asks, low enough that "I have just selected most
 * of my library" is never something you find out afterwards.
 */
export const BIG_GROUP_SELECT = 1000;

/**
 * Should selecting `count` photos in one click be confirmed first?
 *
 * Only ever asked of a SELECT. Deselecting is the way out of a mistake, it is
 * undoable, and making the escape hatch ask a question is how you trap someone.
 *
 * @param {number} count how many photos the click would add
 */
export function needsSelectConfirm(count) {
  return count > BIG_GROUP_SELECT;
}

/**
 * How many of `ids` are present in `selectedSet`.
 * @param {number[]} ids
 * @param {Set<number>} selectedSet
 * @returns {number}
 */
export function intersectionCount(ids, selectedSet) {
  let n = 0;
  for (const id of ids) if (selectedSet.has(id)) n++;
  return n;
}
