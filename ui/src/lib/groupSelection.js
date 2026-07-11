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
