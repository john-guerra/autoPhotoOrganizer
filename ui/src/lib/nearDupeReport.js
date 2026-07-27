/**
 * The sentence the user reads after "Find duplicates" (#211).
 *
 * Pure — no DOM, no Svelte — because the interesting part is the wording and
 * the wording is where this feature has repeatedly gone wrong. #213 was filed
 * because a button reported nothing a user could act on; the fix is not a
 * bigger number but a sentence about their photos.
 *
 * ## Why a selection changes the message and not the sweep
 *
 * #211 asked for duplicate detection over just a selection. The sweep stays
 * whole-library: measured, a full pass over 16,797 embedded photos is 3.2s at
 * the default window, so scoping the computation would trade a consistent
 * grouping for no speed (server/db/nearDupes.js carries the full argument).
 * What a selection scopes is the answer.
 *
 * `spillGroups` is why this is not simply "N groups in your selection". A
 * counted group is one the selection TOUCHES, and it may reach photos outside
 * it — claiming otherwise would credit the selection with photos the user
 * never selected. When it does, the sentence says so rather than rounding it
 * away.
 *
 * @param {{scoped?: {groups: number, photos: number, spillGroups: number}|null,
 *          library: {groups: number, photos: number},
 *          selectionCount?: number|null}} report
 * @returns {string}
 */
export function nearDupeReportMessage({
  scoped = null,
  library,
  selectionCount = null,
}) {
  const libGroups = library?.groups ?? 0;
  const libPhotos = library?.photos ?? 0;

  // No selection: the library IS the scope, so a second number would be the
  // same number twice.
  if (!scoped || !selectionCount) {
    return libGroups
      ? `Found ${plural(libGroups, "group")} of near-identical photos ` +
          `(${libPhotos.toLocaleString()} photos stacked)`
      : "No near-identical photos found — nothing was stacked";
  }

  const of = `your ${plural(selectionCount, "selected photo")}`;

  if (!scoped.groups) {
    // The library count is the actionable half here: "none in your selection"
    // reads as "the feature did nothing" unless it can say the sweep did run
    // and did find things elsewhere.
    return libGroups
      ? `No near-identical photos among ${of} — ${plural(libGroups, "group")} ` +
          `elsewhere in the library`
      : `No near-identical photos among ${of}, or anywhere else in the library`;
  }

  const spill = scoped.spillGroups
    ? `, ${scoped.spillGroups.toLocaleString()} of them reaching photos outside it`
    : "";
  return (
    `Found ${plural(scoped.groups, "group")} of near-identical photos among ` +
    `${of}${spill} (${plural(libGroups, "group")} library-wide)`
  );
}

/** "1 group" / "2 groups" — the plural is on the LAST word so "selected photo"
 *  pluralises as "selected photos" rather than "selecteds photo". */
function plural(n, noun) {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}
