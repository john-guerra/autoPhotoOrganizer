/**
 * What a finished face-grouping job says it did.
 *
 * Extracted because there were TWO copies of this — `JobsPanel.svelte`'s
 * `summarize()` and `FaceSettings.svelte`'s notice — and they had drifted into
 * the same wrong answer independently (#293). Both read `r.people`, which only
 * the REGROUP path returns; the incremental pass returns `created`, and a
 * `?? 0` turned the missing field into a confident "Grouped 327 faces into 0
 * people" for a run that had just made dozens of them.
 *
 * One function, two callers, and it is a pure string function so the wrong
 * field name is a unit test rather than something only a human clicking the
 * app can notice.
 *
 * ## The two shapes, which are genuinely different questions
 *
 * | mode          | comes from       | answers                          |
 * | ------------- | ---------------- | -------------------------------- |
 * | `"regroup"`   | `saveClusters`   | how many people you have NOW      |
 * | `"remaining"` | `groupRemaining` | how many this pass ADDED          |
 *
 * Rendering the second with the first's wording would be wrong even with the
 * right field: "you now have 41 people" after a scoped run that filed 327 of
 * 1,431 faces is not true.
 */

/** @param {number|undefined} v */
const n = (v) => (v ?? 0).toLocaleString();
/** @param {number|undefined} v @param {string} one @param {string} many */
const plural = (v, one, many) => (v === 1 ? one : many);

/**
 * @param {object} [result] a finished `face-cluster` job's `result`
 * @returns {string} one line, already pluralized. Never empty — a bare ✓ with
 *   no summary is an unfinished feature (UI-CONTRACTS §2).
 */
export function faceClusterSummary(result) {
  const r = result ?? {};

  if (r.mode === "remaining") {
    const parts = [
      `filed ${n(r.assigned)} ${plural(r.assigned, "face", "faces")}`,
      `${n(r.created)} new ${plural(r.created, "person", "people")}`,
    ];
    // Only when non-zero: "0 still to do" is noise on the common path, and a
    // non-zero value means they stopped it or scoped it — which is worth
    // saying, because it is the difference between "done" and "done for now".
    if (r.remaining) parts.push(`${n(r.remaining)} still to do`);
    if (r.removedEmpty)
      parts.push(
        `tidied ${n(r.removedEmpty)} empty ${plural(r.removedEmpty, "person", "people")}`
      );
    return parts.join(" · ");
  }

  // `keptManual` is the reassuring half — a regrouping deliberately does NOT
  // touch the people you named or the faces you moved by hand, and saying so
  // is what makes the button safe to press twice.
  const parts = [
    `${n(r.people)} ${plural(r.people, "person", "people")}`,
    `from ${n(r.faces)} ${plural(r.faces, "face", "faces")}`,
  ];
  if (r.keptManual) parts.push(`${n(r.keptManual)} kept as you set them`);
  return parts.join(" · ");
}
