/**
 * The scope choice, as data (#215/#206/#221).
 *
 * "All / Visible / Selected with live counts" is contract 1 in
 * `docs/UI-CONTRACTS.md`, and the contract says one control, not one per
 * feature — three near-identical copies is already Finding 4 of
 * `docs/ML-UX-REVIEW-2026-07-26.md`. The rendering lives in
 * `ScopeControl.svelte`; the arithmetic lives here so it can be tested without
 * a DOM, and so a caller can ask "what ids did they pick?" without reaching
 * into a component.
 *
 * NB `ui/src/lib/scope.js` is a DIFFERENT thing — the feed's working scope
 * ("Keep only", a folder), which is server-side state that persists. This is
 * the transient "what should this one operation run over?" choice.
 */

/** @typedef {"selected"|"visible"|"all"} ScopeKey */

export const DEFAULT_SCOPE = "all";

/**
 * The three choices, in the order the contract fixes, each with its count.
 *
 * `allCount` is the operation's OWN remaining work, not the library total.
 * Embedding quotes pending rather than 34,807 because re-embedding what is
 * done is not work the sweep will do; quoting the total would overstate the
 * cost by two orders of magnitude. Selected and Visible are raw counts and
 * therefore upper bounds — the sweep skips already-done rows inside them too,
 * which is why the estimate says "up to".
 *
 * @param {{selectedIds: unknown[], visibleIds: unknown[], allCount: number,
 *          allLabel?: string}} args
 */
export function buildScopes({
  selectedIds = [],
  visibleIds = [],
  allCount = 0,
  allLabel = "All",
}) {
  return [
    { key: "selected", label: "Selected", n: selectedIds.length },
    { key: "visible", label: "Visible", n: visibleIds.length },
    { key: "all", label: allLabel, n: Math.max(0, allCount) },
  ];
}

/**
 * The chosen scope, falling back to "All" for an unknown key.
 * @param {ReturnType<typeof buildScopes>} scopes
 * @param {string|undefined} choice
 */
export function activeScope(scopes, choice) {
  return scopes.find((s) => s.key === choice) ?? scopes[scopes.length - 1];
}

/**
 * The ids to send, or `null` for the unscoped sweep.
 *
 * `null` and `[]` mean different things all the way down to the SQL (see
 * `server/db/scopeIds.js`): `null` is "the whole library", `[]` is "these zero
 * photos". This function never returns `[]` for "all" and never returns `null`
 * for an empty selection — collapsing them is how an empty selection becomes
 * an hour of inference.
 *
 * @param {string|undefined} choice
 * @param {{selectedIds: unknown[], visibleIds: unknown[]}} sets
 * @returns {unknown[]|null}
 */
export function scopeIdsFor(choice, { selectedIds = [], visibleIds = [] }) {
  if (choice === "selected") return selectedIds;
  if (choice === "visible") return visibleIds;
  return null;
}

/**
 * Roughly how long `n` photos will take, from a measured per-photo cost.
 *
 * Rounded hard and prefixed "about": an order-of-magnitude honesty aid
 * measured on one machine, not a promise. Returns null when there is nothing
 * to estimate — the caller says "nothing to do here" rather than "about 0s".
 *
 * @param {number} n
 * @param {number|undefined} msPerPhoto
 * @returns {string|null}
 */
export function formatEstimate(n, msPerPhoto) {
  if (!msPerPhoto || !n) return null;
  const secs = Math.round((n * msPerPhoto) / 1000);
  if (secs < 60) return `about ${Math.max(1, secs)}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `about ${mins} min`;
  return `about ${(mins / 60).toFixed(1)} h`;
}
